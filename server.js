const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/novumx';
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || 'YourBscScanApiKey';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

// معرف المالك أو الأدمن لجمع نسب الأرباح والرسوم عليه
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || 'YOUR_ADMIN_TELEGRAM_ID';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Successfully'))
  .catch(err => console.error('❌ Database Connection Error:', err));

// ==========================================
// Schemas & Models
// ==========================================
const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: String,
  firstName: String,
  depositBalance: { type: Number, default: 0 },
  withdrawableProfit: { type: Number, default: 0 },
  totalLosses: { type: Number, default: 0 },
  trc20Wallet: { type: String, default: '' },
  bep20Wallet: { type: String, default: '' },
  referredBy: { type: String, default: null },
  referralCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  telegramId: String,
  type: { type: String, enum: ['deposit', 'withdraw', 'reinvest', 'fee_deduction', 'profit_share'] },
  amount: Number,
  currency: { type: String, default: 'USDT' },
  network: { type: String, enum: ['TRC20', 'BEP20', 'INTERNAL'] },
  txHash: String,
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ==========================================
// User Sync API
// ==========================================
app.post('/api/user/sync', async (req, res) => {
  const { user: tgUser, refId } = req.body;
  if (!tgUser || !tgUser.id) return res.status(400).json({ error: 'Invalid user data' });

  try {
    let user = await User.findOne({ telegramId: tgUser.id.toString() });

    if (!user) {
      user = new User({
        telegramId: tgUser.id.toString(),
        username: tgUser.username || '',
        firstName: tgUser.first_name || 'User',
        referredBy: refId && refId !== tgUser.id.toString() ? refId : null
      });

      if (user.referredBy) {
        await User.updateOne({ telegramId: user.referredBy }, { $inc: { referralCount: 1 } });
      }
      await user.save();
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تحديث عناوين المحافظ للمستخدم
app.post('/api/user/update-wallet', async (req, res) => {
  const { telegramId, trc20Wallet, bep20Wallet } = req.body;
  try {
    const updateData = {};
    if (trc20Wallet !== undefined) updateData.trc20Wallet = trc20Wallet;
    if (bep20Wallet !== undefined) updateData.bep20Wallet = bep20Wallet;

    const user = await User.findOneAndUpdate({ telegramId }, { $set: updateData }, { new: true });
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Blockchain Real Verification APIs
// ==========================================
async function verifyTRC20Tx(walletAddress, expectedTxHash) {
  try {
    const url = `https://api.trongrid.io/v1/accounts/${walletAddress}/transactions/trc20`;
    const headers = TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY } : {};
    const response = await axios.get(url, { headers, timeout: 10000 });
    const txs = response.data.data || [];
    
    const found = txs.find(tx => tx.transaction_id === expectedTxHash);
    if (found) {
      const amount = parseFloat(found.value) / Math.pow(10, parseInt(found.token_info.decimals || 6));
      return { verified: true, amount };
    }
    return { verified: false };
  } catch (e) {
    console.error("TRC20 Verification Error:", e.message);
    return { verified: false };
  }
}

async function verifyBEP20Tx(walletAddress, expectedTxHash) {
  try {
    const url = `https://api.bscscan.com/api?module=account&action=tokentx&address=${walletAddress}&sort=desc&apikey=${BSCSCAN_API_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });
    const txs = response.data.result || [];

    const found = txs.find(tx => tx.hash.toLowerCase() === expectedTxHash.toLowerCase());
    if (found) {
      const amount = parseFloat(found.value) / Math.pow(10, parseInt(found.tokenDecimal || 18));
      return { verified: true, amount };
    }
    return { verified: false };
  } catch (e) {
    console.error("BEP20 Verification Error:", e.message);
    return { verified: false };
  }
}

// 1. نظام إيداع مع خصم رسوم 10% لك تلقائياً
app.post('/api/deposit/verify', async (req, res) => {
  const { telegramId, txHash, network } = req.body;
  if (!telegramId || !txHash || !network) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const existingTx = await Transaction.findOne({ txHash });
    if (existingTx) return res.status(400).json({ error: 'تم استخدام معرف المعاملة (TxHash) مسبقاً' });

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const walletAddress = network === 'TRC20' ? user.trc20Wallet : user.bep20Wallet;
    if (!walletAddress) {
      return res.status(400).json({ error: `يرجى ضبط عنوان محفظة ${network} الخاصة بك أولاً` });
    }

    let verificationResult = { verified: false, amount: 0 };

    if (network === 'TRC20') {
      verificationResult = await verifyTRC20Tx(walletAddress, txHash);
    } else if (network === 'BEP20') {
      verificationResult = await verifyBEP20Tx(walletAddress, txHash);
    }

    if (verificationResult.verified && verificationResult.amount > 0) {
      const grossAmount = verificationResult.amount;
      
      // اقتطاع 10% رسوم إيداع لك
      const adminFee = grossAmount * 0.10;
      const netUserAmount = grossAmount - adminFee;

      // تسجيل المعاملة للمستخدم
      await Transaction.create({ telegramId, type: 'deposit', amount: netUserAmount, network, txHash, status: 'completed' });
      
      // تسجيل رسوم الإيداع الخاصة بك
      await Transaction.create({ telegramId: ADMIN_TELEGRAM_ID, type: 'fee_deduction', amount: adminFee, network, txHash, status: 'completed' });

      user.depositBalance += netUserAmount;
      await user.save();

      // إضافة الرسوم لحساب الأدمن (إذا كان مسجلاً كمستخدم في النظام)
      await User.updateOne({ telegramId: ADMIN_TELEGRAM_ID }, { $inc: { withdrawableProfit: adminFee } }, { upsert: true });

      return res.json({ 
        success: true, 
        newBalance: user.depositBalance, 
        depositedAmount: netUserAmount,
        adminFeeCollected: adminFee 
      });
    }

    res.status(400).json({ error: 'لم يتم العثور على المعاملة أو أنها غير مطابقة على شبكة البلوكشين' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. نظام توزيع الأرباح للجلسة مع خصم 25% من إجمالي الربح لك
app.post('/api/trading/distribute-session-profit', async (req, res) => {
  const { sessionTotalProfit, targetTelegramId } = req.body; 
  // إذا أرسلت targetTelegramId يتم تطبيقها على مستخدم محدد، أو يتم توزيعها على جميع المستخدمين المستثمرين

  try {
    const profitAmount = parseFloat(sessionTotalProfit);
    if (isNaN(profitAmount) || profitAmount <= 0) {
      return res.status(400).json({ error: 'قيمة الربح غير صالحة' });
    }

    // حصتك 25% من إجمالي الربح الكلي للجلسة
    const myShare = profitAmount * 0.25;
    // حصة المستخدم 75% المتبقية
    const userShare = profitAmount * 0.75;

    if (targetTelegramId) {
      const user = await User.findOne({ telegramId: targetTelegramId });
      if (user) {
        user.withdrawableProfit += userShare;
        await user.save();
      }
    }

    // إضافة حصتك (25%) إلى حسابك كأدمن
    await User.updateOne(
      { telegramId: ADMIN_TELEGRAM_ID }, 
      { $inc: { withdrawableProfit: myShare } }, 
      { upsert: true }
    );

    // تسجيل العملية كحصة أرباح
    await Transaction.create({
      telegramId: ADMIN_TELEGRAM_ID,
      type: 'profit_share',
      amount: myShare,
      status: 'completed'
    });

    res.json({
      success: true,
      message: 'تم توزيع أرباح الجلسة بنجاح',
      totalSessionProfit: profitAmount,
      yourShare25Percent: myShare,
      userShare75Percent: userShare
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Withdraw & Reinvest APIs
// ==========================================
app.post('/api/withdraw/request', async (req, res) => {
  const { telegramId, amount, network } = req.body;

  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.withdrawableProfit < amount) {
      return res.status(400).json({ error: 'الرصيد المتاح غير كافٍ للسحب' });
    }

    user.withdrawableProfit -= amount;
    await user.save();

    await Transaction.create({ telegramId, type: 'withdraw', amount, network, status: 'pending' });

    res.json({ success: true, message: 'تم إرسال طلب السحب بنجاح وهو قيد المراجعة' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reinvest', async (req, res) => {
  const { telegramId, amount } = req.body;

  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.withdrawableProfit < amount) {
      return res.status(400).json({ error: 'الرصيد غير كافٍ للاستثمار' });
    }

    user.withdrawableProfit -= amount;
    user.depositBalance += amount;
    await user.save();

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Telegram Bot Handler
// ==========================================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `أهلاً بك في منصة NovumX Agent 🚀`, {
    reply_markup: {
      inline_keyboard: [[
        { text: "فتح تطبيق NovumX Agent 📈", web_app: { url: "https://your-netlify-domain.netlify.app" } }
      ]]
    }
  });
});

// ==========================================
// Keep-Alive Mechanism (Render Fix)
// ==========================================
app.get('/', (req, res) => {
  res.send("<h1>NovumX Server is Active & Running 🚀</h1>");
});

setInterval(() => {
  axios.get(RENDER_EXTERNAL_URL)
    .then(() => console.log("[Keep-Alive] Pinged server successfully."))
    .catch(err => console.log("[Keep-Alive] Ping error:", err.message));
}, 4 * 60 * 1000);

// ==========================================
// Start Server
// ==========================================
app.listen(PORT, () => {
  console.log(`✅ NovumX Server running on port ${PORT}`);
});

