```javascript
require('dotenv').config();
const express = require('express');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function checkApiKey(req, res) {
  const apiKey = req.headers['x-api-key'];

  if (apiKey !== process.env.API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }

  return true;
}

function cleanUsername(username) {
  return String(username || '').replace('@', '').toLowerCase();
}

function getCentralDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

async function getViewerByUsername(username) {
  const clean = cleanUsername(username);

  const { data } = await supabase
    .from('viewers')
    .select('*')
    .eq('twitch_login', clean);

  if (!data || data.length === 0) return null;
  return data[0];
}

async function getOrCreateViewer({ twitch_user_id, twitch_login, display_name }) {
  const cleanLogin = cleanUsername(twitch_login || display_name);
  const display = display_name || twitch_login || cleanLogin;

  const existingViewer = await getViewerByUsername(cleanLogin);
  if (existingViewer) return existingViewer;

  const userId = twitch_user_id || `username:${cleanLogin}`;

  await supabase.from('viewers').upsert({
    twitch_user_id: userId,
    twitch_login: cleanLogin,
    display_name: display
  });

  return {
    twitch_user_id: userId,
    twitch_login: cleanLogin,
    display_name: display
  };
}

async function getBalanceByUserId(userId) {
  const { data } = await supabase
    .from('coin_balances')
    .select('balance')
    .eq('twitch_user_id', userId)
    .single();

  return data?.balance || 0;
}

async function addCoinTransaction({
  viewer,
  amount,
  reason,
  sourceChannelId,
  sourceChannelName,
  eventId
}) {
  const { error } = await supabase.rpc('add_coin_transaction', {
    p_twitch_user_id: viewer.twitch_user_id,
    p_twitch_login: viewer.twitch_login,
    p_display_name: viewer.display_name,
    p_amount: amount,
    p_reason: reason,
    p_source_channel_id: sourceChannelId || 'manual',
    p_source_channel_name: sourceChannelName || 'Unknown',
    p_twitch_event_id: eventId || randomUUID()
  });

  return error;
}

app.get('/', (req, res) => {
  res.send('Backend running 💅');
});

//
// 💅 DAILY WITH STREAKS
//
app.post('/daily', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const {
      twitch_user_id,
      twitch_login,
      display_name,
      source_channel_name
    } = req.body;

    const streamName = source_channel_name || 'Unknown';
    const today = getCentralDateString();

    const viewer = await getOrCreateViewer({
      twitch_user_id,
      twitch_login,
      display_name
    });

    const { error: claimError } = await supabase
      .from('daily_claims')
      .insert({
        twitch_user_id: viewer.twitch_user_id,
        source_channel_name: streamName,
        claim_date: today
      });

    if (claimError) {
      return res.send(`${viewer.display_name} already claimed today 😭`);
    }

    const { data: streakData } = await supabase
      .from('daily_streaks')
      .select('*')
      .eq('twitch_user_id', viewer.twitch_user_id)
      .eq('source_channel_name', streamName)
      .single();

    let streak = 1;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const yesterdayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(yesterday);

    if (streakData && streakData.last_claim_date === yesterdayStr) {
      streak = streakData.streak_count + 1;
    }

    let reward = [50, 60, 75, 90, 110, 135][streak - 1] || 175;

    await supabase.from('daily_streaks').upsert({
      twitch_user_id: viewer.twitch_user_id,
      source_channel_name: streamName,
      streak_count: streak,
      last_claim_date: today
    });

    await addCoinTransaction({
      viewer,
      amount: reward,
      reason: `daily streak ${streak}`,
      sourceChannelName: streamName
    });

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    res.send(`${viewer.display_name} on day ${streak} streak 💅 +${reward} Coins | Balance: ${newBalance}`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

//
// 🎲 GAMBLE
//
app.post('/gamble', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const { twitch_login, display_name, amount } = req.body;
    const bet = parseInt(amount, 10);

    const viewer = await getOrCreateViewer({ twitch_login, display_name });
    const balance = await getBalanceByUserId(viewer.twitch_user_id);

    if (balance < bet) {
      return res.send(`${display_name} you’re broke 😭`);
    }

    let winnings = 0;
    let msg = '';

    const roll = Math.random();

    if (roll < 0.5) {
      winnings = -bet;
      msg = `${display_name} lost ${bet} 💀`;
    } else if (roll < 0.97) {
      winnings = bet;
      msg = `${display_name} doubled it 💅 +${bet}`;
    } else {
      winnings = bet * 3;
      msg = `🎰 ${display_name} HIT THE JACKPOT??? | Won ${winnings} Coins 💅🔥`;
    }

    await addCoinTransaction({
      viewer,
      amount: winnings,
      reason: 'gamble'
    });

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    res.send(`${msg} | Balance: ${newBalance}`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

//
// 💸 REDEEM (FIXED + TRIGGER READY)
//
app.post('/redeem', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const {
      twitch_login,
      display_name,
      cost,
      reward_name,
      source_channel_name
    } = req.body;

    const redeemCost = parseInt(cost, 10);

    if (!Number.isFinite(redeemCost) || redeemCost <= 0) {
      return res.send(`That redeem cost is not valid 😭`);
    }

    const viewer = await getOrCreateViewer({
      twitch_login,
      display_name
    });

    const balance = await getBalanceByUserId(viewer.twitch_user_id);

    if (balance < redeemCost) {
      return res.send(`${viewer.display_name} tried to redeem ${reward_name} but is broke 😭`);
    }

    await addCoinTransaction({
      viewer,
      amount: -redeemCost,
      reason: `redeem: ${reward_name}`,
      sourceChannelName: source_channel_name || 'Redeem'
    });

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    res.send(
      `REDEEM|${reward_name}|${viewer.display_name} redeemed ${reward_name} 💅 -${redeemCost} Coins | Balance: ${newBalance}`
    );

  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(process.env.PORT, () => {
  console.log('Server running 💅');
});
```
