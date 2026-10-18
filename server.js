const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/novumx';
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_TELEGRAM_ID';
const TRC20_WALLET = process.env.TRC20_WALLET || 'TH6oMpBo7zZ46iNK8eLDuQ5wGJhYLvWaJN';
const BEP20_WALLET = process.env.BEP20_WALLET || '0x1fF8eE97b120572354Ff53098566744430277DcA';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Successfully'))
  .catch(err => console.error('❌ Database Connection Error:', err));

const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: String,
  firstName: String,
  depositBalance: { type: Number, default: 0 },
  withdrawableProfit: { type: Number, default: 0 },
  totalLosses: { type: Number, default: 0 },
  referredBy: { type: String, default: null },
  referralCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  telegramId: String,
  type: { type: String, enum: ['deposit', 'withdraw', 'reinvest'] },
  amount: Number,
  currency: { type: String, default: 'USDT' },
  network: { type: String, enum: ['TRC20', 'BEP20', 'INTERNAL'] },
  txHash: String,
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

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

app.post('/api/deposit/verify', async (req, res) => {
  const { telegramId, txHash, network } = req.body;
  if (!telegramId || !txHash) return res.status(400).json({ error: 'Missing parameters' });

  try {
    const existingTx = await Transaction.findOne({ txHash });
    if (existingTx) return res.status(400).json({ error: 'Transaction already processed' });

    let amount = 10;
    let isVerified = true;

    if (isVerified && amount >= 10) {
      await Transaction.create({ telegramId, type: 'deposit', amount, network, txHash, status: 'completed' });
      const user = await User.findOneAndUpdate(
        { telegramId },
        { $inc: { depositBalance: amount } },
        { new: true }
      );

      if (user.referredBy) {
        const bonus = amount * 0.05;
        await User.updateOne({ telegramId: user.referredBy }, { $inc: { withdrawableProfit: bonus } });
      }

      return res.json({ success: true, newBalance: user.depositBalance });
    }

    res.status(400).json({ error: 'لم يتم التحقق من المعاملة' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw/request', async (req, res) => {
  const { telegramId, amount, address, network } = req.body;

  try {
    const user = await User.findOne({ telegramId });
    if (!user || user.withdrawableProfit < amount) {
      return res.status(400).json({ error: 'الرصيد المتاح غير كافٍ للسحب' });
    }

    user.withdrawableProfit -= amount;
    await user.save();

    await Transaction.create({ telegramId, type: 'withdraw', amount, network, status: 'pending' });

    res.json({ success: true, message: 'تم إرسال طلب السحب بنجاح' });
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

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `أهلاً بك في منصة NovumX Agent 🚀`, {
    reply_markup: {
      inline_keyboard: [[
        { text: "فتح تطبيق NovumX Agent 📈", web_app: { url: "https://your-netlify-domain.netlify.app" } }
      ]]
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ NovumX Server running on port ${PORT}`);
});
