require('dotenv').config(); 
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const multer = require('multer'); 
const mammoth = require('mammoth'); 
const path = require('path'); 
const mongoose = require('mongoose'); 
const bcrypt = require('bcryptjs');   

// Xử lý import pdf-parse an toàn
let pdfParse = require('pdf-parse');
if (typeof pdfParse !== 'function' && pdfParse.default) {
    pdfParse = pdfParse.default;
}

const app = express();
const PORT = process.env.PORT || 3000;

// --- KẾT NỐI MONGODB ---
const MONGO_URI = process.env.MONGODB_URI; 
if (!MONGO_URI) {
    console.error("❌ LỖI: Chưa cấu hình MONGODB_URI!");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ Đã kết nối MongoDB Cloud"))
        .catch(err => console.error("❌ Lỗi kết nối MongoDB:", err));
}

// --- ĐỊNH NGHĨA MODEL ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'student' }
});
const User = mongoose.model('User', UserSchema);

const ChatSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    username: String,
    title: String,
    subject: String,
    timestamp: Number,
    messages: Array
});
const Chat = mongoose.model('Chat', ChatSchema);

const KnowledgeSchema = new mongoose.Schema({
    content: String,
    vector: [Number],
    source: String,
    subject: String
});
const Knowledge = mongoose.model('Knowledge', KnowledgeSchema);

// --- CẤU HÌNH UPLOAD (Dùng RAM) ---
const storage = multer.memoryStorage(); 
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } 
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname)); 

const TEACHER_SECRET_CODE = process.env.TEACHER_SECRET || "GV123"; 

// --- CẤU HÌNH AI ---
const allKeys = [
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_API_KEY_2,
    process.env.GOOGLE_API_KEY_3,
    process.env.GOOGLE_API_KEY_4
].filter(key => key);

function getGenAI() {
    if (allKeys.length === 0) throw new Error("Không tìm thấy API Key!");
    const randomKey = allKeys[Math.floor(Math.random() * allKeys.length)];
    return new GoogleGenerativeAI(randomKey);
}

// Hàm cắt nhỏ văn bản
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

// Hàm tính độ tương đồng
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- ROUTES ---

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 1. ĐĂNG KÝ
app.post('/register', async (req, res) => {
    const { username, password, role, secretCode } = req.body;
    if (!username || username.length < 4) return res.json({ success: false, error: "Tên đăng nhập > 4 ký tự!" });
    if (!password || password.length < 6) return res.json({ success: false, error: "Mật khẩu > 6 ký tự!" });

    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.json({ success: false, error: "Tên đã tồn tại!" });

        let finalRole = 'student';
        if (role === 'teacher') {
            if (secretCode !== TEACHER_SECRET_CODE) return res.json({ success: false, error: "Sai mã giáo viên!" });
            finalRole = 'teacher';
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ username, password: hashedPassword, role: finalRole });
        await newUser.save();

        res.json({ success: true, user: { username, role: finalRole } });
    } catch (e) {
        res.status(500).json({ success: false, error: "Lỗi Server DB" });
    }
});

// 2. ĐĂNG NHẬP
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) return res.json({ success: false, error: "Sai tài khoản!" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.json({ success: false, error: "Sai mật khẩu!" });

        res.json({ success: true, user: { username: user.username, role: user.role } });
    } catch (e) {
        res.status(500).json({ success: false, error: "Lỗi Server DB" });
    }
});

// 3. LỊCH SỬ CHAT
app.get('/history', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.json([]);
    try {
        const userChats = await Chat.find({ username }, 'id title timestamp').sort({ timestamp: -1 });
        res.json(userChats);
    } catch (e) { res.json([]); }
});

// 4. CHI TIẾT CHAT
app.get('/chat-detail', async (req, res) => {
    try {
        const chat = await Chat.findOne({ id: req.query.id });
        res.json(chat || null);
    } catch (e) { res.json(null); }
});

// 5. XÓA CHAT
app.post('/delete-chat', async (req, res) => {
    const { chatId, username } = req.body;
    try {
        const result = await Chat.deleteOne({ id: chatId, username: username });
        if (result.deletedCount > 0) res.json({ success: true });
        else res.json({ success: false, error: "Không tìm thấy!" });
    } catch (e) { res.json({ success: false, error: "Lỗi khi xóa!" }); }
});

// 6. DANH SÁCH FILE
app.get('/list-files', async (req, res) => {
    try {
        const files = await Knowledge.distinct('source');
        const fileDetails = [];
        for (const f of files) {
            const doc = await Knowledge.findOne({ source: f }, 'subject');
            if (doc) fileDetails.push({ name: f, subject: doc.subject });
        }
        res.json(fileDetails);
    } catch (e) { res.json([]); }
});

// 7. XÓA FILE
app.post('/delete-file', async (req, res) => {
    if (req.headers['role'] !== 'teacher') return res.status(403).json({ success: false, error: "Cấm!" });
    try {
        await Knowledge.deleteMany({ source: req.body.filename });
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// 8. UPLOAD TÀI LIỆU
app.post('/upload-doc', upload.single('file'), async (req, res) => {
    const userRole = req.body.role; 
    const subject = req.body.subject || 'general';

    if (userRole !== 'teacher') {
        return res.status(403).json({ success: false, error: "Quyền giáo viên!" });
    }

    try {
        if (!req.file) throw new Error("Chưa chọn file!");
        
        const genAI = getGenAI();
        let content = "";
        
        const fileBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;
        const originalName = req.file.originalname.toLowerCase();

        if (mimeType === 'application/pdf' || originalName.endsWith('.pdf')) {
            try {
                const pdfData = await pdfParse(fileBuffer);
                content = pdfData.text;
                if (!content || content.trim().length < 50) {
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    const result = await model.generateContent([
                        "Trích xuất toàn bộ văn bản.",
                        { inlineData: { data: fileBuffer.toString("base64"), mimeType: "application/pdf" } },
                    ]);
                    content = result.response.text();
                }
            } catch (err) { console.error("Lỗi PDF:", err); }
        } else if (mimeType.includes('word') || originalName.endsWith('.docx')) {
            const result = await mammoth.convertToHtml({ buffer: fileBuffer });
            content = result.value.replace(/<[^>]*>?/gm, ''); 
        } else {
            content = fileBuffer.toString('utf8');
        }

        if (!content || content.length < 20) throw new Error("File rỗng hoặc không đọc được!");
        
        let textChunks = content.includes("<table") ? [content] : splitTextIntoChunks(content.replace(/[ \t]+/g, " ").trim(), 1000);
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        
        const knowledgeBatch = [];
        for (const chunk of textChunks) {
            const result = await embedModel.embedContent(chunk);
            knowledgeBatch.push({
                content: chunk,
                vector: result.embedding.values,
                source: req.file.originalname,
                subject: subject
            });
        }
        await Knowledge.insertMany(knowledgeBatch);

        res.json({ success: true, message: `Đã học: ${req.file.originalname}` });
    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 9. CHAT VỚI AI (CẬP NHẬT PROMPT CHO QUIZ VÀ MINDMAP)
app.post('/ask-ai', async (req, res) => {
    try {
        const { prompt, subject, username, chatId } = req.body;
        const genAI = getGenAI();
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        
        const docs = await Knowledge.find({ subject: subject });
        
        let contextContent = "";
        let isFallback = false;

        if (docs.length === 0) {
            isFallback = true;
        } else {
            const queryVector = (await embedModel.embedContent(prompt)).embedding.values;
            const scoredDocs = docs.map(doc => ({ 
                source: doc.source, 
                content: doc.content, 
                score: cosineSimilarity(queryVector, doc.vector) 
            }));
            scoredDocs.sort((a, b) => b.score - a.score);
            const topMatches = scoredDocs.slice(0, 5);
            contextContent = topMatches.map(m => `--- Nguồn: ${m.source} ---\n${m.content}`).join("\n\n");
        }

        if (!contextContent && !isFallback) {
             return res.json({ success: true, answer: "Chưa có dữ liệu cho môn này, vui lòng báo giáo viên upload tài liệu.", isFallback: true });
        }

        // --- CẬP NHẬT SYSTEM INSTRUCTION MỚI ---
        const systemInstruction = `
         Bạn là Giáo viên Trợ giảng AI chuyên nghiệp.
        NHIỆM VỤ: Trả lời câu hỏi học sinh dựa trên "DỮ LIỆU THAM KHẢO" (nếu có).
        
        DỮ LIỆU THAM KHẢO:
        ${contextContent}
        
         ⛔ YÊU CẦU VỀ TRÌNH BÀY (RẤT QUAN TRỌNG):
        1. **Bố cục rõ ràng:** Chia câu trả lời thành các đoạn nhỏ, dễ đọc. Sử dụng các tiêu đề (Heading) nếu câu trả lời dài.
        2. **Highlight từ khóa:** BẮT BUỘC phải **in đậm** (dùng **text**) các con số, tên riêng, định nghĩa quan trọng hoặc kết quả chính.
        3. **Dùng danh sách:** Sử dụng gạch đầu dòng (bullet points) cho các ý liệt kê để dễ nhìn.
        4. **Bảng biểu:** Nếu dữ liệu có tính so sánh, hãy trình bày dưới dạng Bảng (Table).

        ⛔ QUY TẮC XỬ LÝ NỘI DUNG:
        - Nếu có thông tin trong dữ liệu: Trả lời chính xác, ngắn gọn và súc tích và chỉ trả lời câu hỏi không ghi "Theo dữ liệu nào hết" gì thêm và ưu tiên những phần cập nhật.
        - Chỉ khi nào CHẮC CHẮN 100% không có trong dữ liệu thì mới dùng kiến thức ngoài và thêm cảnh báo: "*⚠️ Thông tin có thể sai lệch!:**" ở dòng đầu tiên thôi không ghi gì thêm và chỉ trả lời câu hỏi và câu hỏi vẫn phải chính xác.

        ⚠️ QUY TẮC QUAN TRỌNG VỀ ĐỊNH DẠNG:
        
        1. VẼ SƠ ĐỒ TƯ DUY / BIỂU ĐỒ:
           - Nếu học sinh yêu cầu "vẽ sơ đồ", "tóm tắt bằng sơ đồ", "mindmap", "quy trình"...
           - Hãy trả về code **Mermaid.js** nằm trong block code: \`\`\`mermaid ... \`\`\`
           - Sử dụng \`graph LR\` (trái sang phải) hoặc \`graph TD\` (trên xuống dưới).
           - KHÔNG dùng dấu ngoặc đơn hoặc ký tự lạ trong tên node để tránh lỗi syntax.

        2. TẠO TRẮC NGHIỆM / QUIZ:
           - Nếu học sinh yêu cầu "kiểm tra bài cũ", "trắc nghiệm", "tạo quiz", "luyện tập"...
           - Hãy trả về **DUY NHẤT** một mảng JSON chứa các câu hỏi (không thêm lời dẫn).
           - Bọc trong block code: \`\`\`json-quiz ... \`\`\`
           - Cấu trúc JSON bắt buộc:
             [
               {
                 "question": "Câu hỏi ở đây?",
                 "options": ["Đáp án A", "Đáp án B", "Đáp án C", "Đáp án D"],
                 "correct": 0,
                 "explain": "Giải thích ngắn gọn tại sao đúng. tuy nhiên ghi nhớ là không được trích xuất tên file"
               }
             ]
             (Lưu ý: correct là số index: 0=A, 1=B, 2=C, 3=D)

        3. TRẢ LỜI THÔNG THƯỜNG:
           - Dùng Markdown. In đậm **từ khóa**.
           - Nếu không có trong dữ liệu: Thêm cảnh báo "⚠️ Thông tin ngoài tài liệu".
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: systemInstruction });
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        let currentChatId = chatId;
        let chatTitle = "";

        if (username) {
            let chat;
            if (currentChatId) chat = await Chat.findOne({ id: currentChatId });

            if (!chat) {
                currentChatId = Date.now().toString();
                chatTitle = prompt.length > 30 ? prompt.substring(0, 30) + "..." : prompt;
                chat = new Chat({
                    id: currentChatId,
                    username: username,
                    title: chatTitle,
                    timestamp: Date.now(),
                    subject: subject,
                    messages: []
                });
            } else {
                chat.timestamp = Date.now();
                chatTitle = chat.title;
            }

            chat.messages.push({ role: 'user', content: prompt });
            chat.messages.push({ role: 'ai', content: responseText });
            await chat.save();
        }

        res.json({ 
            success: true, 
            answer: responseText, 
            isFallback: responseText.includes("⚠️"),
            chatId: currentChatId, 
            chatTitle: chatTitle
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Lỗi Server AI!" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});