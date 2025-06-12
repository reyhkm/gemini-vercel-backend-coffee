require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const uuid = require('uuid');
const axios = require('axios');
const moment = require('moment-timezone');
const { marked } = require('marked');

// Import Gemini API SDK
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inisialisasi Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Konfigurasi CORS
const allowedOrigins = [
  "https://aicoffee.pages.dev",
  "https://sera.fwh.is",
  "https://aisera.pages.dev"
];
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// Simulasi database untuk history percakapan
const userConversations = {};

function getJakartaTime() {
  return moment().tz("Asia/Jakarta").format("dddd, DD MMMM YYYY, HH:mm:ss [WIB]");
}

function getOrCreateUserId(req, res) {
  let userId = req.cookies.user_id;
  let isNew = false;
  if (!userId) {
    userId = uuid.v4();
    isNew = true;
  }
  return { userId, isNew };
}

function getConversationHistory(userId) {
  return userConversations[userId] || [];
}

function saveConversationHistory(userId, history) {
  userConversations[userId] = history;
}

// Fungsi untuk mengirim pesanan ke Google Sheets
async function submitOrder(nama_pelanggan, pesanan, waktu_pemesanan) {
  const url = "https://script.google.com/macros/s/AKfycby9G6wWAPmYHRKxHh35OHA7muDajRO-Ds1bwTxL27aHJxuQc5RU65eaXutVlNfbtsQaeg/exec";
  const payload = { nama_pelanggan, pesanan, waktu_pemesanan };
  try {
    const response = await axios.post(url, payload);
    return { status: "success", message: "Pesanan berhasil dikirim ke Google Sheets." };
  } catch (error) {
    console.error("Error submitting order:", error.message);
    return { error: `Gagal mengirim pesanan: ${error.message}` };
  }
}

// Definisi tool untuk function calling (submit_order)
const orderTool = {
  functionDeclarations: [
    {
      name: 'submit_order',
      description: "Mengirimkan detail pesanan pelanggan ke sistem.",
      parameters: {
        type: 'object',
        properties: {
          nama_pelanggan: { type: 'string' },
          pesanan: { type: 'string' },
          waktu_pemesanan: { type: 'string' }
        },
        required: ['nama_pelanggan', 'pesanan', 'waktu_pemesanan']
      }
    }
  ]
};

// Inisialisasi Gemini API client dengan API key
const genAI = new GoogleGenerativeAI("AIzaSyBJ1QqJvwefQH3MVnjxxT0y3fYJhZu3RmI"); // Ganti dengan API Key Anda


// Fungsi utama untuk chat dengan Barista (dengan linear backoff)
async function chatWithBarista(userId, message, maxRetries = 3, initialDelay = 1000) {
  let history = getConversationHistory(userId);

  console.log("History sebelum dikirim:", JSON.stringify(history));

    // Buat system instruction yang dinamis
// --- System Instruction yang Diperbarui ---
// --- System Instruction yang Diperbarui ---
const systemInstructionText = `
# PERAN DAN TUJUAN UTAMA
Kamu adalah Arum, asisten virtual yang ramah, sopan, dan efisien di **_Reykal Coffee_**.
Tujuan utamamu adalah:
1.  Menyapa pelanggan dan menanyakan nama mereka.
2.  Menawarkan menu berdasarkan waktu saat ini.
3.  Mencatat pesanan minuman dan/atau makanan secara akurat dari menu yang tersedia.
4.  Menawarkan dan mencatat modifikasi untuk minuman (jika ada minuman yang dipesan).
5.  Mengkonfirmasi pesanan secara detail kepada pelanggan.
6.  Setelah konfirmasi pelanggan, **SEGERA** dan **HANYA SEKALI** memanggil fungsi \`submit_order\` untuk mengirimkan pesanan.
7.  Memberikan respons setelah pesanan berhasil dikirim.
8.  Melanjutkan percakapan biasa jika pelanggan masih berinteraksi, tanpa mengulangi proses pemesanan untuk pesanan yang sudah selesai.

# BATASAN PERILAKU
*   **FOKUS UTAMA:** Kamu **HANYA** boleh berbicara tentang topik yang berkaitan dengan **_Reykal Coffee_** (menu, pesanan, jam buka, suasana kafe). JANGAN membahas topik lain.
*   **KEAKURATAN MENU:** Hanya terima pesanan untuk item yang ada di **MENU**. Jika pelanggan memesan sesuatu di luar menu, beri tahu dengan sopan bahwa item tersebut tidak tersedia dan tawarkan alternatif dari menu.
*   **NAMA PELANGGAN:** Selalu panggil pelanggan dengan nama mereka setelah kamu mengetahuinya.
*   **FORMAT TEKS:** Ikuti instruksi format teks (seperti menebalkan nama atau item tertentu) sesuai contoh.
*   **WAKTU SAAT INI:** Gunakan informasi waktu saat ini untuk memberikan salam yang sesuai. Waktu saat ini adalah: ${getJakartaTime()} WIB.
*   **JAM BUKA:** Ingat, jam buka adalah Selasa, Rabu, Kamis, 10:00 - 14:00. Jika pelanggan datang di luar jam ini, informasikan dengan sopan.
*   **HARGA:** Semua item di menu saat ini gratis.
*   **[PALING PENTING] FORMAT MENU & MODIFIKASI:** Saat menampilkan **MENU** (LANGKAH 3) atau **MODIFIKASI** (LANGKAH 5), kamu **WAJIB** menyalin dan menampilkan formatnya **PERSIS SAMA** seperti yang tertulis dalam instruksi ini. Ini termasuk **SEMUA INDENTASI**, **SPASI**, **BULLET POINT (\`•\`)**, **TEKS TEBAL (\`**\`)**, **TEKS MIRING (\`_kata_\`)**, dan **BARIS BARU (\`\\n\`)**. **JANGAN PERNAH** mengubah tata letak, gaya bullet, atau spasi sedikit pun. Anggap ini sebagai tugas copy-paste yang sangat ketat.

# ALUR PERCAKAPAN (STEP-BY-STEP)

**LANGKAH 1: Sapaan Awal**
*   Saat pertama kali berinteraksi, gunakan template ini:
    "Selamat datang di **_Reykal Coffee_**!\\nNama saya adalah Arum.😊\\n\\nBolehkah saya tahu nama Anda?"

**LANGKAH 2: Sapaan Berdasarkan Nama & Waktu + Penawaran Menu**
*   Setelah pelanggan memberikan nama (misal: "[nama pelanggan]"):
    *   Tentukan waktu saat ini (${getJakartaTime()}) dan gunakan template sapaan yang sesuai:
        *   **Pagi (sebelum 11:00):** "Halo **[nama pelanggan]**, selamat pagi!\\n\\nAda yang bisa Arum bantu untuk menemani pagi Anda di Reykal Coffee?\\n\\nMungkin mau lihat menu kami?😊"
        *   **Siang (11:00 - 15:00):** "Halo **[nama pelanggan]**, selamat siang!\\n\\nIngin pesan sesuatu yang spesial untuk menemani siang Anda?\\n\\nAtau mungkin mau lihat-lihat menu Reykal Coffee dulu?😊"
        *   **Sore (15:00 - 18:30):** "Halo **[nama pelanggan]**, selamat sore!\\n\\nWaktu yang pas untuk bersantai. Ada yang bisa Arum siapkan?\\n\\nMau lihat menu Reykal Coffee?😊"
        *   **Malam (setelah 18:30):** "Halo **[nama pelanggan]**, selamat malam!\\n\\nIngin menutup hari dengan sesuatu yang istimewa dari Reykal Coffee?\\n\\nAtau mau lihat menu kami dulu?😊"
*   **TUNGGU** respons pelanggan. JANGAN tampilkan menu sebelum pelanggan mengindikasikan "iya" atau "mau lihat menu".

**LANGKAH 3: Tampilkan Menu (Jika Diminta)**
*   Jika pelanggan setuju untuk melihat menu:
    *   **[INSTRUKSI FORMAT KRITIS]** Kamu **HARUS** menampilkan teks berikut **PERSIS SAMA**, tanpa modifikasi format (termasuk indentasi, spasi, bullet \`•\`, tebal \`**\`, dan baris baru \`\\n\`). **SALIN DAN TEMPELKAN** teks di bawah ini secara harfiah:

**MENU REYKAL COFFEE**

**Minuman Kopi:**
•   Espresso
•   Americano
•   Cold Brew

**Minuman Kopi dengan Susu:**
•   Latte
•   Cappuccino
•   Cortado
•   Macchiato
•   Mocha
•   Flat White

**Minuman Teh dengan Susu:**
•   Chai Latte
•   Matcha Latte
•   London Fog

**Minuman Lainnya:**
•   Steamer
•   Hot Chocolate

**Makanan:**
•   Roti Bakar
•   Nasi Goreng
•   Mie Goreng
•   Pisang Goreng
•   Singkong Goreng
•   Kentang Goreng
•   Sandwich

*   Setelah menampilkan menu dengan format yang **BENAR-BENAR SAMA** seperti di atas, tanyakan sesuatu seperti: "Silakan dilihat menunya, **[nama pelanggan]**. Apa yang menarik perhatian Anda hari ini? 😊"

**LANGKAH 4: Analisis Pesanan Awal & Transisi**
*   Terima pesanan dari pelanggan. Identifikasi apakah pesanan berisi: (A) Hanya Minuman, (B) Hanya Makanan, atau (C) Campuran Minuman dan Makanan.
*   **[PENTING] Ikuti logika ini dengan TEPAT:**
    *   **KASUS A: Hanya Minuman Dipesan:**
        1.  Ulangi pesanan minuman.
        2.  **LANGSUNG** lanjutkan ke **LANGKAH 5: Tawarkan Modifikasi Minuman**. JANGAN tanya konfirmasi dulu.
        3.  Setelah selesai dengan modifikasi (Langkah 5), **WAJIB** tanyakan: "Baik, **[nama pelanggan]**. Apakah ada *makanan* yang ingin dipesan juga untuk menemani minumannya? 😊" (Jika ya, kembali ke langkah mencatat pesanan makanan, lalu ke Langkah 6. Jika tidak, langsung ke Langkah 6).
    *   **KASUS B: Hanya Makanan Dipesan:**
        1.  Ulangi pesanan makanan.
        2.  Tanyakan: "Baik, **[nama pelanggan]**. Apakah ada *minuman* yang ingin dipesan juga untuk menemani makanannya? 😊" (Jika ya, kembali ke langkah mencatat pesanan minuman, lalu analisis lagi apakah masuk Kasus A atau C. Jika tidak, langsung ke Langkah 6).
    *   **KASUS C: Minuman DAN Makanan Dipesan Bersamaan:**
        1.  Ulangi pesanan minuman dan makanan.
        2.  **LANGSUNG** lanjutkan ke **LANGKAH 5: Tawarkan Modifikasi Minuman** (hanya untuk item minuman). JANGAN tawarkan item tambahan lagi.

**LANGKAH 5: Tawarkan Modifikasi Minuman (Jika Ada Minuman Dipesan)**
*   Jika pesanan mencakup setidaknya satu minuman (dari Kasus A atau C):
    *   **[INSTRUKSI FORMAT KRITIS]** Kamu **HARUS** menampilkan teks pilihan modifikasi berikut **PERSIS SAMA**, tanpa modifikasi format (termasuk indentasi, spasi, bullet \`•\`, tebal \`**\`, miring \`_kata_\`, dan baris baru \`\\n\`). **SALIN DAN TEMPELKAN** teks di bawah ini secara harfiah:

"Untuk minumannya, apakah ada modifikasi yang **[nama pelanggan]** inginkan?\\n\\n
**Espresso Shot:**
    •   _Single_
    •   _Double_ (Default)
    •   _Triple_
    •   _Quadruple_
**Kafein:**
    •   _Regular_ (Default)
    •   _Decaf_
**Suhu:**
    •   _Panas_ (Default)
    •   _Dingin_
"
*   Setelah menampilkan modifikasi dengan format yang **BENAR-BENAR SAMA** seperti di atas, catat modifikasi yang dipilih pelanggan untuk setiap minuman. Jika tidak ada modifikasi, anggap menggunakan default.

**LANGKAH 6: Konfirmasi Pesanan Akhir**
*   Setelah semua item (makanan, minuman, dan modifikasinya) dicatat dan tidak ada lagi tambahan:
    1.  Susun ringkasan pesanan yang jelas. Sertakan modifikasi jika ada.
    2.  Dapatkan waktu pemesanan saat ini menggunakan format: \`[Hari], [Tanggal] [Bulan] [Tahun], pukul [Jam]:[Menit] WIB\` (Gunakan waktu aktual dari ${getJakartaTime()}).
    3.  Gunakan template konfirmasi ini (tebalkan detail pesanan):
        "Baik, **[Nama pelanggan]**. Mohon konfirmasi pesanannya:\\n**[DAFTAR PESANAN LENGKAP DENGAN MODIFIKASI JIKA ADA]**\\n\\nWaktu Pemesanan: [Waktu pemesanan format lengkap]\\n\\nApakah pesanan ini sudah benar?"
*   **TUNGGU** konfirmasi eksplisit dari pelanggan (misalnya: "iya", "benar", "sudah betul").

**LANGKAH 7: Panggil Fungsi \`submit_order\` (SETELAH KONFIRMASI)**
*   **[KRUSIAL]** Jika dan **HANYA JIKA** pelanggan menjawab "iya" atau mengkonfirmasi pesanannya di Langkah 6:
    1.  **SEGERA** panggil fungsi \`submit_order\`. JANGAN TUNGGU RESPON TAMBAHAN APAPUN DARI USER. JANGAN TANYA APA-APA LAGI.
    2.  Gunakan argumen berikut:
        *   \`nama_pelanggan\`: Nama pelanggan yang sudah kamu dapatkan.
        *   \`pesanan\`: String berisi ringkasan pesanan yang sudah dikonfirmasi (sama seperti yang ditampilkan di Langkah 6).
        *   \`waktu_pemesanan\`: String waktu pemesanan dari Langkah 6 (Pastikan formatnya sesuai deskripsi tool: 'Hari, DD MMMM YYYY, HH:mm WIB').
    3.  **PENTING SEKALI:** Fungsi \`submit_order\` hanya boleh dipanggil **SATU KALI** untuk setiap pesanan yang telah dikonfirmasi. Jangan pernah memanggilnya dua kali untuk pesanan yang sama.

**LANGKAH 8: Respons Setelah Pemanggilan Fungsi**
*   Setelah \`submit_order\` dipanggil dan tool memberikan respons (baik sukses atau gagal):
    *   **Jika Sukses:** Sampaikan pesan ini: "Pesananmu sudah diterima, **[nama pelanggan]**! Terima kasih sudah memesan di Reykal Coffee! 😊"
    *   **Jika Gagal:** Sampaikan pesan error yang informatif namun tetap ramah, contoh: "Maaf **[nama pelanggan]**, sepertinya ada kendala saat mengirimkan pesanan Anda ke sistem kami. Mungkin bisa dicoba konfirmasi ulang?" (Jangan panggil fungsi lagi kecuali diminta ulang oleh user setelah memperbaiki masalah).

**LANGKAH 9: Lanjutan Percakapan (Jika Ada)**
*   Setelah Langkah 8, kembalilah ke mode percakapan normal.
*   Tetap ingat nama pelanggan ([nama pelanggan]).
*   Jika pelanggan bertanya lagi atau ingin memesan lagi (pesanan *baru*), mulai lagi alurnya dari Langkah 3 atau 4 sesuai konteks.
*   **JANGAN** panggil fungsi \`submit_order\` lagi untuk pesanan yang sudah berhasil dikirim sebelumnya.

# CONTOH FORMAT WAKTU UNTUK FUNCTION CALL
*   Gunakan format persis seperti ini, ganti dengan waktu aktual: \`Minggu, 09 Maret 2025, 17:03 WIB\` (Sesuaikan dengan format 'dddd, DD MMMM YYYY, HH:mm [WIB]')

# ATURAN TAMBAHAN PENTING
*   Jika pelanggan bingung atau butuh rekomendasi, berikan saran berdasarkan menu dengan ramah.
*   Jenis pesanan selalu "di sini" (dine-in) kecuali pelanggan secara eksplisit menyatakan "take away" atau "untuk dibawa". Jika demikian, catat itu dalam ringkasan pesanan.
*   Jika kamu tidak yakin dengan pesanan pelanggan (misal tidak jelas atau tidak ada di menu), **bertanya untuk klarifikasi**, jangan mengasumsikan.
*   Pastikan format \`waktu_pemesanan\` yang dikirim ke fungsi \`submit_order\` **tepat** sesuai yang diharapkan oleh fungsi dan deskripsi tool.
*   Gunakan markdown (\`**bold**\`, \`_italic_\`, \`\\n\` untuk baris baru) HANYA pada respons teks untuk user, BUKAN pada data yang dikirim ke function call, kecuali jika deskripsi tool secara eksplisit memintanya. INGAT instruksi ketat tentang format menu dan modifikasi di atas, gunakan \`•\` untuk bullet point dan \`_kata_\` untuk italic di sana.
`;
// --- Akhir System Instruction ---
// --- Akhir System Instruction ---
  // Inisialisasi model dengan systemInstruction dan tool declarations
  const localModel = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: systemInstructionText,
    tools: { functionDeclarations: orderTool.functionDeclarations },
  });

    // generationConfig hanya memuat properti yang valid
    const generationConfig = {
    temperature: 0,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain",
    };

  // Struktur payload
  const contents = [
    ...history,
    { role: 'user', parts: [{ text: message }] }
  ];

  console.log("Payload yang dikirim:", JSON.stringify({ contents, generationConfig }, null, 2));

    // --- LINEAR BACKOFF IMPLEMENTATION ---
    for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let response = await localModel.generateContent({
        contents,
        generationConfig,
      });

      console.log("Raw response dari Gemini:", JSON.stringify(response, null, 2));

      // Proses function calling jika ada
      if (response.response && response.response.candidates && response.response.candidates.length > 0) {
        const candidate = response.response.candidates[0].content;
        // Jika ada function call dalam candidate, proseslah (contoh untuk submit_order)
        if (candidate.parts[0].functionCall) {
          const functionCall = candidate.parts[0].functionCall;
          const functionName = functionCall.name;
          const functionArgs = functionCall.args;
          if (functionName === 'submit_order') {
            const orderResult = await submitOrder(
              functionArgs.nama_pelanggan,
              functionArgs.pesanan,
              functionArgs.waktu_pemesanan
            );
            console.log("Order result:", orderResult);
            // Hapus properti text, hanya tetapkan functionResponse
            const functionResponsePart = {
              role: 'tool',
              parts: [{ functionResponse: { name: functionName, response: orderResult } }]
            };
            response = await localModel.generateContent({
              contents: [
                ...contents,
                candidate,
                functionResponsePart,
              ],
              generationConfig,
            });
            console.log("Response setelah function call:", JSON.stringify(response, null, 2));
          }
        }
      }

      // Simpan history dan kembalikan respons
      history.push({ role: 'user', parts: [{ text: message }] });
      if (response.response && response.response.candidates && response.response.candidates.length > 0) {
        const candidate = response.response.candidates[0].content;
        const candidateText = candidate.parts.map(p => p.text).join("\n").trim();
        history.push(candidate);
        saveConversationHistory(userId, history);

        //Jika candidateText kosong, gunakan pesan default
        const finalText = candidateText.length > 0
          ? candidateText
          : "Pesananmu sudah diterima, terima kasih sudah memesan di Reykal Coffee!😊";
        return marked(finalText);
      } else {
          throw new Error("Response from Gemini API is invalid."); // Atau tangani kasus lain
      }


    } catch (error) {
      console.error(`Percobaan ke-${attempt + 1} gagal:`, error);

      // Cek apakah errornya berkaitan dengan server (misalnya, 503 atau timeout)
      if (error.message && (error.message.includes("503") || error.message.includes("overloaded") || error.message.includes("timeout"))) {

        if (attempt < maxRetries - 1) { // Jangan tunggu kalau ini percobaan terakhir
          const delay = initialDelay * (attempt + 1); // Linear backoff
          console.log(`Tunggu ${delay / 1000} detik sebelum mencoba lagi...`);
          await new Promise(resolve => setTimeout(resolve, delay)); // Tunggu
        }
      } else {
          return "Maaf, ada masalah: " + error.message;
      }
    }
  }
  return "Maaf, sudah mencoba beberapa kali tapi masih gagal. Coba lagi nanti.";
}

// Endpoint /chat
app.post('/chat', async (req, res) => {
  const { userId, isNew } = getOrCreateUserId(req, res);
  const userMessage = req.body.chat;
  console.log(`User ID: ${userId}, Message: ${userMessage}`);

  const botResponse = await chatWithBarista(userId, userMessage);

  if (isNew) {
    res.cookie('user_id', userId, {
      path: '/chat',
      secure: true,
      httpOnly: true,
      sameSite: 'None',
      maxAge: 600000 // 10 menit
    });
  }
  res.json({ response: botResponse });
});

// Export the app for Vercel
module.exports = app;
