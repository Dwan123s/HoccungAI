// 1. Dòng này BẮT BUỘC ở trên cùng
require('dotenv').config(); 

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const mammoth = require('mammoth'); 
const path = require('path'); // Thêm thư viện xử lý đường dẫn

let pdfParse = require('pdf-parse');
if (typeof pdfParse !== 'function' && pdfParse.default) {
    pdfParse = pdfParse.default;
}

// --- TỰ ĐỘNG TẠO THƯ MỤC UPLOADS (FIX LỖI UPLOAD) ---
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const MY_API_KEY = process.env.GOOGLE_API_KEY; 
const TEACHER_SECRET_CODE = process.env.TEACHER_SECRET; 
const PORT = process.env.PORT || 3000;

// Fallback nếu quên cấu hình env trên máy local (để demo chạy được ngay)
if (!MY_API_KEY) {
    console.warn("⚠️ CẢNH BÁO: Chưa có API Key trong .env hoặc Environment Variables!");
}

const app = express();

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/') },
    filename: function (req, file, cb) { 
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, Date.now() + '-' + safeName) 
    }
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- FIX LỖI GIAO DIỆN (PHỤC VỤ FILE Ở ROOT) ---
app.use(express.static('.')); 

const genAI = new GoogleGenerativeAI(MY_API_KEY);

let vectorStore = []; 
let users = [];

function splitTextIntoChunks(text, chunkSize = 1500) {
    const chunks = [];
    const sentences = text.split(/(?<=[.?!])\s+/); 
    let currentChunk = "";
    for (const sentence of sentences) {
        if ((currentChunk + sentence).length < chunkSize) {
            currentChunk += sentence + " ";
        } else {
            chunks.push(currentChunk.trim());
            currentChunk = sentence + " ";
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

function loadData() {
    if (fs.existsSync('knowledge.json')) {
        try { vectorStore = JSON.parse(fs.readFileSync('knowledge.json', 'utf8')); } catch (e) { vectorStore = []; }
    } else { fs.writeFileSync('knowledge.json', '[]'); }

    if (fs.existsSync('users.json')) {
        try { users = JSON.parse(fs.readFileSync('users.json', 'utf8')); } catch (e) { users = []; }
    } else { fs.writeFileSync('users.json', '[]'); }
    console.log(`Server ready. Loaded ${vectorStore.length} items.`);
}

function saveUsers() { fs.writeFileSync('users.json', JSON.stringify(users, null, 2)); }
function saveKnowledge() { fs.writeFileSync('knowledge.json', JSON.stringify(vectorStore, null, 2)); }

function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

loadData();

// ROUTE TRANG CHỦ (Quan trọng để Render hiển thị web)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/register', (req, res) => {
    const { username, password, role, secretCode } = req.body;
    if (users.find(u => u.username === username)) return res.json({ success: false, error: "Tên đã tồn tại!" });
    let finalRole = 'student';
    if (role === 'teacher') {
        if (secretCode === TEACHER_SECRET_CODE) finalRole = 'teacher';
        else return res.json({ success: false, error: "Sai mã giáo viên!" });
    }
    users.push({ username, password, role: finalRole });
    saveUsers();
    res.json({ success: true, user: { username, role: finalRole } });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) res.json({ success: true, user: { username: user.username, role: user.role } });
    else res.json({ success: false, error: "Sai thông tin!" });
});

app.get('/list-files', (req, res) => {
    const files = vectorStore.map(item => ({ name: item.source, subject: item.subject || 'general' }));
    const uniqueFiles = [...new Map(files.map(item => [item.name, item])).values()];
    res.json(uniqueFiles);
});

app.post('/delete-file', (req, res) => {
    if (req.headers['role'] !== 'teacher') return res.status(403).json({ success: false, error: "Không có quyền!" });
    const { filename } = req.body;
    const initLen = vectorStore.length;
    vectorStore = vectorStore.filter(item => item.source !== filename);
    if (vectorStore.length < initLen) {
        saveKnowledge();
        res.json({ success: true });
    } else res.json({ success: false, error: "Không tìm thấy file!" });
});

app.post('/upload-doc', upload.single('file'), async (req, res) => {
    const userRole = req.body.role; 
    const subject = req.body.subject || 'general';

    if (userRole !== 'teacher') {
        if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: "Chỉ giáo viên mới được upload!" });
    }

    try {
        if (!req.file) throw new Error("Chưa chọn file!");
        
        let content = "";
        const filePath = req.file.path;
        const mimeType = req.file.mimetype;
        const originalName = req.file.originalname.toLowerCase();

        if (mimeType === 'application/pdf' || originalName.endsWith('.pdf')) {
            const dataBuffer = fs.readFileSync(filePath);
            if (typeof pdfParse !== 'function') throw new Error("Lỗi thư viện PDF.");
            const pdfData = await pdfParse(dataBuffer);
            content = pdfData.text;

            if (!content || content.trim().length < 50) {
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                const result = await model.generateContent([
                    "Trích xuất toàn bộ văn bản.",
                    { inlineData: { data: Buffer.from(fs.readFileSync(filePath)).toString("base64"), mimeType: "application/pdf" } },
                ]);
                content = result.response.text();
            }
        } 
        else if (mimeType.includes('word') || originalName.endsWith('.docx')) {
            const result = await mammoth.convertToHtml({ path: filePath });
            content = result.value; 
        } 
        else {
            content = fs.readFileSync(filePath, 'utf8');
        }

        if (!content || content.length < 20) throw new Error("File rỗng!");

        let textChunks = [];
        if (content.includes("<table")) {
             textChunks = [content]; 
        } else {
            content = content.replace(/[ \t]+/g, " ").trim(); 
            textChunks = splitTextIntoChunks(content, 1000);
        }
        
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        for (const chunk of textChunks) {
            const result = await embedModel.embedContent(chunk);
            vectorStore.push({ 
                content: chunk, 
                vector: result.embedding.values, 
                source: req.file.originalname,
                subject: subject 
            });
        }
        saveKnowledge();
        fs.unlinkSync(filePath); 
        res.json({ success: true, message: `Success: ${req.file.originalname}` });

    } catch (error) {
        console.error(error);
        if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: error.message });
    }
});

const TEACHER_PROMPT = `
Bạn là một Trợ lý AI đặc biệt của nhà trường.

⛔ LUẬT BẤT KHẢ XÂM PHẠM:
1. **DỮ LIỆU LÀ CHÂN LÝ:** Bạn PHẢI trả lời dựa hoàn toàn vào phần "DỮ LIỆU THAM KHẢO" bên dưới.
2. **QUÊN ĐI THỰC TẾ:** Nếu tài liệu nói A, thực tế là B -> BẮT BUỘC TRẢ LỜI LÀ A.
   - Ví dụ: Tài liệu nói "Việt Nam có 34 tỉnh"-> BẠN PHẢI TRẢ LỜI LÀ 34 TỈNH.
3. **ƯU TIÊN CỘT 'CẬP NHẬT':** Nếu trong tài liệu có bảng so sánh, hãy luôn lấy thông tin ở cột "NỘI DUNG CẬP NHẬT".

YÊU CẦU TRÌNH BÀY:
- Dùng Markdown.
- Trích xuất chính xác con số trong bảng HTML.
`;

app.post('/ask-ai', async (req, res) => {
    try {
        const { prompt, subject } = req.body;
        
        const relevantDocs = vectorStore.filter(doc => doc.subject === subject);
        const docsToSearch = relevantDocs.length > 0 ? relevantDocs : vectorStore;

        if (docsToSearch.length === 0) {
             return res.json({ success: true, answer: `⚠️ Chưa có tài liệu nào trong hệ thống.`, isFallback: true });
        }

        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const queryVector = (await embedModel.embedContent(prompt)).embedding.values;

        const scoredDocs = docsToSearch.map(doc => ({ ...doc, score: cosineSimilarity(queryVector, doc.vector) }));
        scoredDocs.sort((a, b) => b.score - a.score);
        const topMatches = scoredDocs.slice(0, 3);
        const bestScore = topMatches.length > 0 ? topMatches[0].score : 0;

        const contextContent = topMatches.map(m => `--- Nguồn: ${m.source} ---\n${m.content}`).join("\n\n");

        const THRESHOLD = 0.35;
        const isFallback = bestScore < THRESHOLD;
        let systemInstruction = TEACHER_PROMPT;

        if (isFallback) {
            systemInstruction = `Bạn là Giáo viên. Thông tin học sinh hỏi KHÔNG CÓ trong tài liệu. Hãy trả lời bằng kiến thức bổ trợ và CẢNH BÁO học sinh: "⚠️ Nội dung này chưa có trong tài liệu trường."`;
        } else {
            systemInstruction += `\n\n✅ **DỮ LIỆU THAM KHẢO (ĐÂY LÀ CHÂN LÝ, HÃY LÀM THEO):**\n${contextContent}`;
        }

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: systemInstruction 
        });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        
        res.json({ success: true, answer: response.text(), isFallback });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Lỗi Server!" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});