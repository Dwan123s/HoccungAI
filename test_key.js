const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- DÁN KEY CỦA BẠN VÀO ĐÂY ---
const MY_API_KEY = "AIzaSyBULjI2veOpIGlpFu7sro59dKAWsMQUi0I"; 

const genAI = new GoogleGenerativeAI(MY_API_KEY);

async function checkAvailableModels() {
  console.log("-----------------------------------------");
  console.log("🔍 Đang kiểm tra danh sách Model khả dụng...");
  try {
    // Chúng ta sẽ dùng model đặc biệt này để lấy danh sách
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    // Gọi thẳng vào API hệ thống để liệt kê model
    // Lưu ý: Dùng fetch thủ công để bỏ qua lỗi SDK nếu có
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${MY_API_KEY}`);
    
    if (response.status !== 200) {
        console.log(`❌ Lỗi kết nối đến Google! Mã lỗi: ${response.status}`);
        console.log("👉 Có thể API Key này bị chặn hoặc chưa kích hoạt dịch vụ.");
        return;
    }

    const data = await response.json();
    
    console.log("✅ KẾT NỐI THÀNH CÔNG! Dưới đây là các model bạn được phép dùng:");
    if (data.models) {
        data.models.forEach(m => {
            // Chỉ hiện các model tạo văn bản (generateContent)
            if (m.supportedGenerationMethods.includes("generateContent")) {
                console.log(`   - "${m.name.replace('models/', '')}"`);
            }
        });
        console.log("\n💡 HÃY COPY CHÍNH XÁC MỘT TRONG CÁC TÊN TRÊN VÀO SERVER.JS");
    } else {
        console.log("⚠️ Không tìm thấy model nào. Tài khoản này có vấn đề.");
    }

  } catch (error) {
    console.error("❌ Lỗi nghiêm trọng:", error);
  }
}

checkAvailableModels();