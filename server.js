require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

let pdfParse = require('pdf-parse');
if (typeof pdfParse !== 'function' && pdfParse.default) {
    pdfParse = pdfParse.default;
}

const app = express();
const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
    console.error("❌ LỖI: Chưa cấu hình MONGODB_URI!");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log("✅ Đã kết nối MongoDB Cloud"))
        .catch(err => console.error("❌ Lỗi kết nối MongoDB:", err));
}

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

const ExamFileSchema = new mongoose.Schema({
    filename: String,
    subject: String,
    grade: String,
    content: String,
    images: [String],
    quizData: Array,
    uploadedBy: String,
    uploadedAt: { type: Date, default: Date.now }
});
const ExamFile = mongoose.model('ExamFile', ExamFileSchema);

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const TEACHER_SECRET_CODE = process.env.TEACHER_SECRET || "GV123";

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

async function processExamFile(buffer, mimeType) {
    let textContent = "";
    let images = [];
    if (mimeType.includes('word') || mimeType.includes('officedocument')) {
        const result = await mammoth.convertToHtml({ buffer: buffer });
        let html = result.value;
        const imgRegex = /<img src="data:image\/([^;]+);base64,([^"]+)" \/>/g;
        let imgIndex = 0;
        textContent = html.replace(imgRegex, (match, type, data) => {
            const base64Str = `data:image/${type};base64,${data}`;
            images.push(base64Str);
            return ` [[IMG_${imgIndex++}]] `; 
        });
        textContent = textContent.replace(/<[^>]*>?/gm, '').replace(/\n\s*\n/g, '\n').trim();
    } else if (mimeType === 'application/pdf') {
        try {
            const data = await pdfParse(buffer);
            textContent = data.text;
        } catch (e) { textContent = ""; }
    } else {
        textContent = buffer.toString('utf-8');
    }
    return { content: textContent, images: images };
}

async function generateQuizDataFromAI(content) {
    const model = getGenAI().getGenerativeModel({ model: "gemini-2.5-flash" });
    const finalPrompt = `
    Dưới đây là nội dung đề thi. Ký hiệu [[IMG_x]] là vị trí hình ảnh.
    TÀI LIỆU: """${content}"""

    NHIỆM VỤ:
    1. Trích xuất TOÀN BỘ câu hỏi trắc nghiệm.
    2. Giữ nguyên ký hiệu [[IMG_x]] trong câu hỏi nếu có.
    3. Trả về JSON Array thuần túy (Không markdown).

    CẤU TRÚC:
    [
        {
            "question": "Nội dung câu hỏi (kèm [[IMG_x]])",
            "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
            "correct": 0,
            "explain": "Giải thích."
        }
    ]
    `;
    const result = await model.generateContent(finalPrompt);
    let text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(text);
}

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.post('/register', async (req, res) => { const { username, password, role, secretCode } = req.body; if (!username || username.length < 4) return res.json({ success: false, error: "Tên > 4 ký tự!" }); if (!password || password.length < 6) return res.json({ success: false, error: "Mật khẩu > 6 ký tự!" }); try { const existingUser = await User.findOne({ username }); if (existingUser) return res.json({ success: false, error: "Tên đã tồn tại!" }); let finalRole = 'student'; if (role === 'teacher') { if (secretCode !== TEACHER_SECRET_CODE) return res.json({ success: false, error: "Sai mã giáo viên!" }); finalRole = 'teacher'; } const salt = await bcrypt.genSalt(10); const hashedPassword = await bcrypt.hash(password, salt); const newUser = new User({ username, password: hashedPassword, role: finalRole }); await newUser.save(); res.json({ success: true, user: { username, role: finalRole } }); } catch (e) { res.status(500).json({ success: false, error: "Lỗi DB" }); } });
app.post('/login', async (req, res) => { const { username, password } = req.body; try { const user = await User.findOne({ username }); if (!user) return res.json({ success: false, error: "Sai tài khoản!" }); const isMatch = await bcrypt.compare(password, user.password); if (!isMatch) return res.json({ success: false, error: "Sai mật khẩu!" }); res.json({ success: true, user: { username: user.username, role: user.role } }); } catch (e) { res.status(500).json({ success: false, error: "Lỗi DB" }); } });

app.get('/history', async (req, res) => { try { const userChats = await Chat.find({ username: req.query.username }, 'id title timestamp').sort({ timestamp: -1 }); res.json(userChats); } catch (e) { res.json([]); } });
app.get('/chat-detail', async (req, res) => { try { const chat = await Chat.findOne({ id: req.query.id }); res.json(chat || null); } catch (e) { res.json(null); } });
app.post('/delete-chat', async (req, res) => { try { await Chat.deleteOne({ id: req.body.chatId, username: req.body.username }); res.json({ success: true }); } catch (e) { res.json({ success: false }); } });

app.get('/list-files', async (req, res) => { try { const files = await Knowledge.distinct('source'); const fileDetails = []; for (const f of files) { const doc = await Knowledge.findOne({ source: f }, 'subject'); if (doc) fileDetails.push({ name: f, subject: doc.subject }); } res.json(fileDetails); } catch (e) { res.json([]); } });
app.post('/delete-file', async (req, res) => { if (req.headers['role'] !== 'teacher') return res.status(403).json({ success: false }); try { await Knowledge.deleteMany({ source: req.body.filename }); res.json({ success: true }); } catch (e) { res.json({ success: false }); } });
app.post('/upload-doc', upload.single('file'), async (req, res) => { if (req.body.role !== 'teacher') return res.status(403).json({ success: false, error: "Quyền giáo viên!" }); try { if (!req.file) throw new Error("Chưa chọn file!"); const { content } = await processExamFile(req.file.buffer, req.file.mimetype); if (!content || content.length < 20) throw new Error("File rỗng!"); let textChunks = splitTextIntoChunks(content.replace(/[ \t]+/g, " ").trim(), 1000); const embedModel = getGenAI().getGenerativeModel({ model: "text-embedding-004" }); const knowledgeBatch = []; for (const chunk of textChunks) { const result = await embedModel.embedContent(chunk); knowledgeBatch.push({ content: chunk, vector: result.embedding.values, source: req.file.originalname, subject: req.body.subject || 'general' }); } await Knowledge.insertMany(knowledgeBatch); res.json({ success: true, message: `Đã học: ${req.file.originalname}` }); } catch (error) { res.status(500).json({ success: false, error: error.message }); } });

app.post('/upload-exam', upload.single('file'), async (req, res) => {
    if (req.body.role !== 'teacher') return res.status(403).json({ success: false, error: "Chỉ giáo viên!" });
    req.setTimeout(120000);
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "Thiếu file!" });
        const { content, images } = await processExamFile(req.file.buffer, req.file.mimetype);
        if (!content || content.length < 50) return res.status(400).json({ success: false, error: "Nội dung quá ngắn!" });
        let quizJson = [];
        try { quizJson = await generateQuizDataFromAI(content); } catch (aiError) { return res.status(500).json({ success: false, error: "Lỗi AI tạo đề." }); }
        await ExamFile.deleteOne({ filename: req.file.originalname }); 
        const newExam = new ExamFile({
            filename: req.file.originalname,
            subject: req.body.subject,
            grade: req.body.grade || "12",
            content: content,
            images: images,
            quizData: quizJson,
            uploadedBy: 'teacher'
        });
        await newExam.save();
        res.json({ success: true, message: "Đã tạo đề thi thành công!" });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/list-exams', async (req, res) => {
    try {
        const { subject, grade } = req.query;
        const filter = {};
        if (subject && subject !== 'all') filter.subject = subject;
        if (grade && grade !== 'all') filter.grade = grade;
        const exams = await ExamFile.find(filter, 'filename subject grade uploadedAt').sort({ uploadedAt: -1 });
        res.json(exams);
    } catch (e) { res.json([]); }
});

app.post('/delete-exam', async (req, res) => {
    if (req.body.role !== 'teacher') return res.status(403).json({ success: false, error: "Chỉ giáo viên!" });
    try { await ExamFile.findByIdAndDelete(req.body.examId); res.json({ success: true }); } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/take-quiz', async (req, res) => {
    try {
        const { examId } = req.body;
        const exam = await ExamFile.findById(examId);
        if (!exam || !exam.quizData) return res.status(404).json({ success: false, error: "Lỗi đề thi!" });
        const finalQuizData = exam.quizData.map(q => {
            q.question = q.question.replace(/\[\[IMG_(\d+)\]\]/g, (match, index) => {
                const imgData = exam.images[parseInt(index)];
                return imgData ? `<br><img src="${imgData}" style="max-width:100%; border-radius:8px; margin:10px 0;" /><br>` : "";
            });
            return q;
        });
        res.json({ success: true, data: finalQuizData });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/ask-ai', async (req, res) => {
    try {
        const { prompt, subject, username, chatId } = req.body;
        const genAI = getGenAI();
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        
        const docs = await Knowledge.find({ subject: subject });
        let contextContent = "";
        let isFallback = false;

        if (docs.length > 0) {
            const queryVector = (await embedModel.embedContent(prompt)).embedding.values;
            const scoredDocs = docs.map(doc => ({ 
                source: doc.source, content: doc.content, 
                score: cosineSimilarity(queryVector, doc.vector) 
            }));
            scoredDocs.sort((a, b) => b.score - a.score);
            const topMatches = scoredDocs.slice(0, 5);
            contextContent = topMatches.map(m => `--- Nguồn: ${m.source} ---\n${m.content}`).join("\n\n");
        } else { isFallback = true; }

        if (!contextContent && !isFallback) return res.json({ success: true, answer: "Chưa có dữ liệu.", isFallback: true });

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
        - Nếu có thông tin trong dữ liệu: Trả lời chính xác, ngắn gọn và súc tích và chỉ trả lời câu hỏi không ghi "Theo dữ liệu nào hết" gì thêm và ưu tiên những phần cập nhật.
        - Chỉ khi nào CHẮC CHẮN 100% không có trong dữ liệu thì mới dùng kiến thức ngoài và thêm cảnh báo: "*⚠️ Thông tin có thể sai lệch!:**" ở dòng đầu tiên thôi không ghi gì thêm và chỉ trả lời câu hỏi và câu hỏi vẫn phải chính xác.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: systemInstruction });
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const finalIsFallback = isFallback || responseText.includes("⚠️");

        let currentChatId = chatId;
        let chatTitle = "";
        if (username) {
            let chat;
            if (currentChatId) chat = await Chat.findOne({ id: currentChatId });
            if (!chat) {
                currentChatId = Date.now().toString();
                chatTitle = prompt.substring(0, 30);
                chat = new Chat({ id: currentChatId, username, title: chatTitle, timestamp: Date.now(), subject, messages: [] });
            }
            chat.messages.push({ role: 'user', content: prompt });
            chat.messages.push({ role: 'ai', content: responseText, isFallback: finalIsFallback });
            await chat.save();
        }

        res.json({ success: true, answer: responseText, isFallback: finalIsFallback, chatId: currentChatId, chatTitle: chatTitle });
    } catch (error) { res.status(500).json({ success: false, error: "Lỗi Server!" }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));