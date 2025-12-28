// server.js - Phiên bản MongoDB + Bảo mật
require('dotenv').config(); 
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const mammoth = require('mammoth'); 
const path = require('path'); 
const mongoose = require('mongoose'); // MỚI: Quản lý Database
const bcrypt = require('bcryptjs');   // MỚI: Mã hóa mật khẩu

let pdfParse = require('pdf-parse');
if (typeof pdfParse !== 'function' && pdfParse.default) {
    pdfParse = pdfParse.default;
}

const app = express();
const PORT = process.env.PORT || 3000;

// --- KẾT NỐI MONGODB ---
// Bạn cần tạo biến môi trường MONGODB_URI trong file .env hoặc trên server
const MONGO_URI = process.env.MONGODB_URI; 
if (!MONGO_URI) {
    console.error("❌ LỖI: Chưa cấu hình MONGODB_URI!");
    process.exit(1);
}
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Đã kết nối MongoDB Cloud"))
    .catch(err => console.error("❌ Lỗi kết nối MongoDB:", err));

// --- ĐỊNH NGHĨA MODEL (SCHEMA) ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // Mật khẩu sẽ được mã hóa
    role: { type: String, default: 'student' }
});
const User = mongoose.model('User', UserSchema);

const ChatSchema = new mongoose.Schema({
    id: { type: String, unique: true }, // ID chat (dùng timestamp như cũ)
    username: String,
    title: String,
    subject: String,
    timestamp: Number,
    messages: Array // Lưu mảng tin nhắn
});
const Chat = mongoose.model('Chat', ChatSchema);

const KnowledgeSchema = new mongoose.Schema({
    content: String,
    vector: [Number], // Lưu vector embedding
    source: String,
    subject: String
});
const Knowledge = mongoose.model('Knowledge', KnowledgeSchema);

// --- CẤU HÌNH UPLOAD ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

const TEACHER_SECRET_CODE = process.env.TEACHER_SECRET || "GV123"; 

// --- CẤU HÌNH AI ---
const allKeys = [
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_API_KEY_2,
    process.env.GOOGLE_API_KEY_3
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

// 1. ĐĂNG KÝ (CÓ MÃ HÓA PASSWORD)
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

        // Mã hóa mật khẩu trước khi lưu
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ username, password: hashedPassword, role: finalRole });
        await newUser.save();

        res.json({ success: true, user: { username, role: finalRole } });
    } catch (e) {
        res.status(500).json({ success: false, error: "Lỗi Server" });
    }
});

// 2. ĐĂNG NHẬP (SO SÁNH HASH)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) return res.json({ success: false, error: "Sai tài khoản!" });

        // So sánh mật khẩu nhập vào với mật khẩu đã mã hóa trong DB
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.json({ success: false, error: "Sai mật khẩu!" });

        res.json({ success: true, user: { username: user.username, role: user.role } });
    } catch (e) {
        res.status(500).json({ success: false, error: "Lỗi Server" });
    }
});

// 3. LẤY DANH SÁCH LỊCH SỬ CHAT (TỪ MONGODB)
app.get('/history', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.json([]);
    try {
        const userChats = await Chat.find({ username }, 'id title timestamp')
                                    .sort({ timestamp: -1 }); // Mới nhất lên đầu
        res.json(userChats);
    } catch (e) { res.json([]); }
});

// 4. LẤY CHI TIẾT CHAT
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
    } catch (e) {
        res.json({ success: false, error: "Lỗi khi xóa!" });
    }
});

// 6. DANH SÁCH FILE
app.get('/list-files', async (req, res) => {
    try {
        // Lấy danh sách các nguồn file duy nhất
        const files = await Knowledge.distinct('source');
        // Vì distinct chỉ trả về tên, ta cần lấy thêm subject. Cách này hơi thủ công nhưng đơn giản:
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
        if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: "Quyền giáo viên!" });
    }

    try {
        if (!req.file) throw new Error("Chưa chọn file!");
        const genAI = getGenAI();
        let content = "";
        const filePath = req.file.path;
        
        // ... (Giữ nguyên logic đọc file PDF/Word/Text cũ) ...
        const mimeType = req.file.mimetype;
        const originalName = req.file.originalname.toLowerCase();
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
        } else if (mimeType.includes('word') || originalName.endsWith('.docx')) {
            const result = await mammoth.convertToHtml({ path: filePath });
            content = result.value; 
        } else {
            content = fs.readFileSync(filePath, 'utf8');
        }

        if (!content || content.length < 20) throw new Error("File rỗng!");
        
        let textChunks = content.includes("<table") ? [content] : splitTextIntoChunks(content.replace(/[ \t]+/g, " ").trim(), 1000);
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        
        // Lưu vào MongoDB thay vì biến vectorStore
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

        fs.unlinkSync(filePath); 
        res.json({ success: true, message: `Đã học: ${req.file.originalname}` });
    } catch (error) {
        if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 9. CHAT VỚI AI
app.post('/ask-ai', async (req, res) => {
    try {
        const { prompt, subject, username, chatId } = req.body;
        const genAI = getGenAI();
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        
        // 1. Tìm kiếm Vector (Đơn giản hóa: Lấy hết document của môn học về RAM để tính cosine - Tốt cho quy mô nhỏ)
        // Lưu ý: Quy mô lớn cần dùng MongoDB Atlas Vector Search (phức tạp hơn)
        const docs = await Knowledge.find({ subject: subject });
        
        let contextContent = "";
        let isFallback = false;

        if (docs.length === 0) {
            isFallback = true;
             // Vẫn cho AI trả lời nhưng đánh dấu fallback
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
             return res.json({ success: true, answer: "Chưa có dữ liệu cho môn này!", isFallback: true });
        }

        const systemInstruction = `
        Bạn là Giáo viên Trợ giảng AI.
        DỮ LIỆU THAM KHẢO:
        ${contextContent}
        ... (Giữ nguyên Prompt cũ) ...
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: systemInstruction });
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        // 2. Lưu Chat vào MongoDB
        let currentChatId = chatId;
        let chatTitle = "";

        if (username) {
            let chat;
            if (currentChatId) {
                chat = await Chat.findOne({ id: currentChatId });
            }

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
                chat.timestamp = Date.now(); // Cập nhật thời gian để nhảy lên đầu
                chatTitle = chat.title;
            }

            chat.messages.push({ role: 'user', content: prompt });
            chat.messages.push({ role: 'ai', content: responseText });
            await chat.save(); // Lưu xuống DB
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