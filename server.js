// 1. Dòng này BẮT BUỘC ở trên cùng
require('dotenv').config(); 

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const mammoth = require('mammoth'); 
const path = require('path'); 

// --- FIX LỖI THƯ VIỆN PDF ---
let pdfParse = require('pdf-parse');
if (typeof pdfParse !== 'function' && pdfParse.default) {
    pdfParse = pdfParse.default;
}

const app = express();

// --- CẤU HÌNH UPLOADS ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, UPLOAD_DIR) },
    filename: function (req, file, cb) { 
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, Date.now() + '-' + safeName) 
    }
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname)); 

const TEACHER_SECRET_CODE = process.env.TEACHER_SECRET; 
const PORT = process.env.PORT || 3000;

// ============================================================
// 🔑 HỆ THỐNG KEY
// ============================================================
const allKeys = [
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_API_KEY_2,
    process.env.GOOGLE_API_KEY_3,
    process.env.GOOGLE_API_KEY_4
].filter(key => key);

if (allKeys.length === 0) console.error("❌ LỖI: Không tìm thấy API Key!");

function getGenAI() {
    const randomKey = allKeys[Math.floor(Math.random() * allKeys.length)];
    return new GoogleGenerativeAI(randomKey);
}

// ============================================================
// QUẢN LÝ DỮ LIỆU
// ============================================================
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
    const knowledgePath = path.join(__dirname, 'knowledge.json');
    const usersPath = path.join(__dirname, 'users.json');

    if (fs.existsSync(knowledgePath)) {
        try { vectorStore = JSON.parse(fs.readFileSync(knowledgePath, 'utf8')); } catch (e) { vectorStore = []; }
    } else { fs.writeFileSync(knowledgePath, '[]'); }

    if (fs.existsSync(usersPath)) {
        try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch (e) { users = []; }
    } else { fs.writeFileSync(usersPath, '[]'); }
    console.log(`✅ Server sẵn sàng. Đã tải ${vectorStore.length} đoạn dữ liệu.`);
}

function saveUsers() { fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(users, null, 2)); }
function saveKnowledge() { fs.writeFileSync(path.join(__dirname, 'knowledge.json'), JSON.stringify(vectorStore, null, 2)); }

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

// --- ROUTES ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

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
        const genAI = getGenAI();
        let content = "";
        const filePath = req.file.path;
        const mimeType = req.file.mimetype;
        const originalName = req.file.originalname.toLowerCase();

        // 1. PDF (Có hỗ trợ OCR)
        if (mimeType === 'application/pdf' || originalName.endsWith('.pdf')) {
            const dataBuffer = fs.readFileSync(filePath);
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
        // 2. WORD (Giữ HTML bảng)
        else if (mimeType.includes('word') || originalName.endsWith('.docx')) {
            const result = await mammoth.convertToHtml({ path: filePath });
            content = result.value; 
        } else {
            content = fs.readFileSync(filePath, 'utf8');
        }

        if (!content || content.length < 20) throw new Error("File rỗng!");

        let textChunks = content.includes("<table") ? [content] : splitTextIntoChunks(content.replace(/[ \t]+/g, " ").trim(), 1000);
        
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        for (const chunk of textChunks) {
            const result = await embedModel.embedContent(chunk);
            vectorStore.push({ content: chunk, vector: result.embedding.values, source: req.file.originalname, subject: subject });
        }
        saveKnowledge();
        fs.unlinkSync(filePath); 
        res.json({ success: true, message: `Đã học: ${req.file.originalname}` });
    } catch (error) {
        console.error("Lỗi upload:", error);
        if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// 🧠 PHẦN XỬ LÝ AI TRẢ LỜI (LOGIC MỚI: LUÔN GỬI TÀI LIỆU)
// ============================================================

// ... (Các phần import và config ở trên giữ nguyên)

// ============================================================
// 🧠 PHẦN XỬ LÝ AI TRẢ LỜI (ĐÃ TỐI ƯU PROMPT ĐỂ TRÌNH BÀY ĐẸP)
// ============================================================

app.post('/ask-ai', async (req, res) => {
    try {
        const { prompt, subject } = req.body;
        
        // 1. Lọc tài liệu theo môn
        const relevantDocs = vectorStore.filter(doc => doc.subject === subject);
        const docsToSearch = relevantDocs.length > 0 ? relevantDocs : vectorStore;

        if (docsToSearch.length === 0) {
             return res.json({ success: true, answer: `⚠️ **Chưa có dữ liệu!**\n\nHệ thống chưa có tài liệu nào cho môn này. Vui lòng tải lên tài liệu để bắt đầu.`, isFallback: true });
        }

        const genAI = getGenAI();
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const queryVector = (await embedModel.embedContent(prompt)).embedding.values;

        // 2. Tính điểm
        const scoredDocs = docsToSearch.map(doc => ({ ...doc, score: cosineSimilarity(queryVector, doc.vector) }));
        scoredDocs.sort((a, b) => b.score - a.score);
        
        const topMatches = scoredDocs.slice(0, 5); 
        const contextContent = topMatches.map(m => `--- Nguồn: ${m.source} ---\n${m.content}`).join("\n\n");
        // 3. Prompt Cực Mạnh để xử lý Layout
        const systemInstruction = `
        Bạn là Giáo viên Trợ giảng AI chuyên nghiệp.
        
        NHIỆM VỤ: Trả lời câu hỏi học sinh dựa trên "DỮ LIỆU THAM KHẢO" ngắn gọn dễ hiểu dành cho học sinh.

        DỮ LIỆU THAM KHẢO:
        ${contextContent}

        ⛔ YÊU CẦU VỀ TRÌNH BÀY (RẤT QUAN TRỌNG):
        1. **Bố cục rõ ràng:** Chia câu trả lời thành các đoạn nhỏ, dễ đọc. Sử dụng các tiêu đề (Heading) nếu câu trả lời dài.
        2. **Highlight từ khóa:** BẮT BUỘC phải **in đậm** (dùng **text**) các con số, tên riêng, định nghĩa quan trọng hoặc kết quả chính.
        3. **Dùng danh sách:** Sử dụng gạch đầu dòng (bullet points) cho các ý liệt kê để dễ nhìn.
        4. **Bảng biểu:** Nếu dữ liệu có tính so sánh, hãy trình bày dưới dạng Bảng (Table).

        ⛔ QUY TẮC XỬ LÝ NỘI DUNG:
        - Nếu có thông tin trong dữ liệu: Trả lời chính xác, ngắn gọn và súc tích và chỉ trả lời câu hỏi không ghi "Theo dữ liệu nào hết" gì thêm.
        - Chỉ khi nào CHẮC CHẮN 100% không có trong dữ liệu thì mới dùng kiến thức ngoài và thêm cảnh báo: "**⚠️ Thông tin có thể sai lệch!:**" ở dòng đầu tiên thôi không ghi gì thêm và chỉ trả lời câu hỏi và câu hỏi vẫn phải chính xác.
        `;

        // 4. Gọi Model
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", 
            systemInstruction: systemInstruction 
        });

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        
        const isFallback = responseText.includes("⚠️");

        res.json({ success: true, answer: responseText, isFallback: isFallback });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Lỗi Server!" });
    }
});

// ... (Phần listen giữ nguyên)

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});