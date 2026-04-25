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

const DAILY_AMOUNT = parseInt(process.env.DAILY_AMOUNT || '50', 10);

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

  const { data, error } = await supabase
    .from('viewers')
    .select(`
      twitch_user_id,
      twitch_login,
      display_name,
      coin_balances (
        balance,
        updated_at
      )
    `)
    .eq('twitch_login', clean);

  if (error || !data || data.length === 0) return null;

  const withBalance = data.find(
    viewer => viewer.coin_balances && viewer.coin_balances.length > 0
  );

  return withBalance || data[0];
}

async function getOrCreateViewer({ twitch_user_id, twitch_login, display_name }) {
  const cleanLogin = cleanUsername(twitch_login || display_name);
  const display = display_name || twitch_login || cleanLogin;

  const existingViewer = await getViewerByUsername(cleanLogin);

  if (existingViewer) {
    return existingViewer;
  }

  const userId = twitch_user_id || `username:${cleanLogin}`;

  const { error } = await supabase
    .from('viewers')
    .upsert(
      {
        twitch_user_id: userId,
        twitch_login: cleanLogin,
        display_name: display
      },
      {
        onConflict: 'twitch_user_id'
      }
    );

  if (error) throw error;

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
    p_source_channel_name: sourceChannelName || 'Unknown Stream',
    p_twitch_event_id: eventId || randomUUID()
  });

  return error;
}

app.get('/', (req, res) => {
  res.send('Shared Coins Backend is running');
});

app.post('/add-coins', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const {
    twitch_user_id,
    twitch_login,
    display_name,
    amount,
    reason,
    source_channel_id,
    source_channel_name,
    twitch_event_id
  } = req.body;

  const { error } = await supabase.rpc('add_coin_transaction', {
    p_twitch_user_id: twitch_user_id,
    p_twitch_login: twitch_login,
    p_display_name: display_name,
    p_amount: amount,
    p_reason: reason,
    p_source_channel_id: source_channel_id,
    p_source_channel_name: source_channel_name,
    p_twitch_event_id: twitch_event_id
  });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});

app.post('/daily', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const {
      twitch_user_id,
      twitch_login,
      display_name,
      source_channel_id,
      source_channel_name
    } = req.body;

    const streamName = source_channel_name || 'Unknown Stream';
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
      if (claimError.code === '23505') {
        return res.send(
          `${viewer.display_name} already claimed today's daily from ${streamName} 😭 come back tomorrow`
        );
      }

      return res.status(500).send(`Daily claim failed: ${claimError.message}`);
    }

    const addError = await addCoinTransaction({
      viewer,
      amount: DAILY_AMOUNT,
      reason: `daily claim from ${streamName}`,
      sourceChannelId: source_channel_id || 'daily',
      sourceChannelName: streamName,
      eventId: `daily_${viewer.twitch_user_id}_${streamName}_${today}_${randomUUID()}`
    });

    if (addError) {
      return res.status(500).send(`Coins could not be added: ${addError.message}`);
    }

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    res.send(
      `${viewer.display_name} claimed ${DAILY_AMOUNT} daily coins from ${streamName} 💅 New balance: ${newBalance} coins`
    );
  } catch (error) {
    res.status(500).send(error.message || 'Daily claim failed.');
  }
});

app.post('/admin/reset-daily', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const {
    target_username,
    admin_username,
    source_channel_name
  } = req.body;

  const streamName = source_channel_name || 'Unknown Stream';
  const today = getCentralDateString();
  const viewer = await getViewerByUsername(target_username);

  if (!viewer) {
    return res.status(404).send(`${target_username} is not in the coin bank yet.`);
  }

  const { error, count } = await supabase
    .from('daily_claims')
    .delete({ count: 'exact' })
    .eq('twitch_user_id', viewer.twitch_user_id)
    .eq('source_channel_name', streamName)
    .eq('claim_date', today);

  if (error) {
    return res.status(500).send(`Could not reset daily: ${error.message}`);
  }

  if (!count) {
    return res.send(`${viewer.display_name} did not have a daily claim for ${streamName} today. Nothing to reset 😌`);
  }

  res.send(`${viewer.display_name}'s daily claim for ${streamName} has been reset by ${admin_username || 'a mod'} 🔄`);
});

app.get('/balance/:user_id', async (req, res) => {
  const balance = await getBalanceByUserId(req.params.user_id);
  res.json({ balance });
});

app.get('/coins/:username', async (req, res) => {
  const viewer = await getViewerByUsername(req.params.username);

  if (!viewer) return res.json({ balance: 0 });

  const balance = await getBalanceByUserId(viewer.twitch_user_id);

  res.json({ balance });
});

app.get('/coins-message/:username', async (req, res) => {
  const username = cleanUsername(req.params.username);
  const viewer = await getViewerByUsername(username);

  if (!viewer) {
    return res.send(`${username} has 0 coins… broke behavior 😭`);
  }

  const balance = await getBalanceByUserId(viewer.twitch_user_id);
  const user = viewer.display_name || username;

  let messages;

  if (balance <= 0) {
    messages = [
      `${user} has 0 coins… oh that’s not— 😭`,
      `${user} is broke broke. Like spiritually. 💀`,
      `${user} has 0 coins. Not even a crumb 😔`,
      `${user} checked their balance and the vault laughed 💀`
    ];
  } else if (balance < 100) {
    messages = [
      `${user} has ${balance} coins. A humble little stack 😌`,
      `${user} has ${balance} coins… starter pack energy`,
      `${user} is sitting on ${balance} coins. We all start somewhere 😭`,
      `${user} has ${balance} coins. It’s giving side quest money`
    ];
  } else if (balance < 500) {
    messages = [
      `${user} has ${balance} coins 💅 cute little savings account`,
      `${user} has ${balance} coins… okay I see you 👀`,
      `${user} is sitting on ${balance} coins like it’s nothing 😌`,
      `${user} has ${balance} coins. Not broke, not rich, just vibing`
    ];
  } else if (balance < 1000) {
    messages = [
      `${user} has ${balance} coins… it’s giving rich 💅`,
      `${user} has ${balance} coins. Don’t get bold now 🧍‍♀️`,
      `${user} has ${balance} coins… HELLO???`,
      `${user} really said “I’m rich” with ${balance} coins 💀`
    ];
  } else {
    messages = [
      `${user} has ${balance} coins… okay economy destroyer 😭`,
      `${user} has ${balance} coins. Stay mad 🥱`,
      `${user} has ${balance} coins… I’m watching you differently now 👀`,
      `${user} has ${balance} coins. This is villain behavior 💀`
    ];
  }

  res.send(messages[Math.floor(Math.random() * messages.length)]);
});

app.post('/admin/add-coins', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const {
    target_username,
    amount,
    admin_username,
    source_channel_id,
    source_channel_name
  } = req.body;

  const viewer = await getViewerByUsername(target_username);
  const coinAmount = parseInt(amount, 10);

  if (!viewer) return res.status(404).send(`${target_username} is not in the coin bank yet.`);
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    return res.status(400).send(`Amount must be a positive number.`);
  }

  const error = await addCoinTransaction({
    viewer,
    amount: coinAmount,
    reason: `admin add by ${admin_username || 'unknown admin'}`,
    sourceChannelId: source_channel_id,
    sourceChannelName: source_channel_name || 'Admin Command',
    eventId: `admin_add_${randomUUID()}`
  });

  if (error) return res.status(500).send(`Could not add coins: ${error.message}`);

  const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

  res.send(`${viewer.display_name} got ${coinAmount} coins added. New balance: ${newBalance} coins 💅`);
});

app.post('/admin/remove-coins', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const {
    target_username,
    amount,
    admin_username,
    source_channel_id,
    source_channel_name
  } = req.body;

  const viewer = await getViewerByUsername(target_username);
  const coinAmount = parseInt(amount, 10);

  if (!viewer) return res.status(404).send(`${target_username} is not in the coin bank yet.`);
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    return res.status(400).send(`Amount must be a positive number.`);
  }

  const error = await addCoinTransaction({
    viewer,
    amount: -coinAmount,
    reason: `admin remove by ${admin_username || 'unknown admin'}`,
    sourceChannelId: source_channel_id,
    sourceChannelName: source_channel_name || 'Admin Command',
    eventId: `admin_remove_${randomUUID()}`
  });

  if (error) return res.status(500).send(`Could not remove coins: ${error.message}`);

  const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

  res.send(`${viewer.display_name} lost ${coinAmount} coins. New balance: ${newBalance} coins 😭`);
});

app.post('/admin/set-coins', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const {
    target_username,
    amount,
    admin_username,
    source_channel_id,
    source_channel_name
  } = req.body;

  const viewer = await getViewerByUsername(target_username);
  const targetAmount = parseInt(amount, 10);

  if (!viewer) return res.status(404).send(`${target_username} is not in the coin bank yet.`);
  if (!Number.isFinite(targetAmount) || targetAmount < 0) {
    return res.status(400).send(`Amount must be 0 or higher.`);
  }

  const currentBalance = await getBalanceByUserId(viewer.twitch_user_id);
  const difference = targetAmount - currentBalance;

  const error = await addCoinTransaction({
    viewer,
    amount: difference,
    reason: `admin set by ${admin_username || 'unknown admin'}`,
    sourceChannelId: source_channel_id,
    sourceChannelName: source_channel_name || 'Admin Command',
    eventId: `admin_set_${randomUUID()}`
  });

  if (error) return res.status(500).send(`Could not set coins: ${error.message}`);

  res.send(`${viewer.display_name}'s balance is now ${targetAmount} coins. Admin magic happened ✨`);
});

app.get('/leaderboard', async (req, res) => {
  const limit = parseInt(req.query.limit || '5', 10);

  const { data, error } = await supabase
    .from('coin_balances')
    .select(`
      twitch_user_id,
      balance,
      viewers (
        twitch_login,
        display_name
      )
    `)
    .order('balance', { ascending: false })
    .limit(limit);

  if (error) {
    return res.status(500).send(`Could not load leaderboard: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return res.send('No one has coins yet. Broke leaderboard behavior 😭');
  }

  const leaderboard = data
    .map((entry, index) => {
      const viewer = entry.viewers;
      const name = viewer?.display_name || viewer?.twitch_login || entry.twitch_user_id;
      return `${index + 1}. ${name}: ${entry.balance} coins`;
    })
    .join(' | ');

  res.send(`🏆 Top 5 coin goblins: ${leaderboard}`);
});

app.post('/fishing-reward', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const {
      twitch_login,
      display_name,
      rarity,
      catch_name,
      source_channel_name
    } = req.body;

    const cleanRarity = String(rarity || '').toLowerCase();
    const streamName = source_channel_name || 'LurkBait Fishing';

    const rewardMap = {
      junk: 0,
      common: 1,
      uncommon: 3,
      rare: 10,
      epic: 25,
      legendary: 75
    };

    const rewardAmount = rewardMap[cleanRarity] ?? 0;

    const viewer = await getOrCreateViewer({
      twitch_login,
      display_name
    });

    if (rewardAmount <= 0) {
      return res.send('');
    }

    const addError = await addCoinTransaction({
      viewer,
      amount: rewardAmount,
      reason: `fishing reward: ${rarity} ${catch_name}`,
      sourceChannelId: 'lurkbait',
      sourceChannelName: streamName,
      eventId: `fish_${viewer.twitch_user_id}_${Date.now()}_${randomUUID()}`
    });

    if (addError) {
      return res.status(500).send(`Fishing reward failed: ${addError.message}`);
    }

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    if (cleanRarity === 'legendary') {
      return res.send(
        `${viewer.display_name} JUST PULLED A LEGENDARY ${catch_name.toUpperCase()}??? HELLO??? +${rewardAmount} COINS 💅🔥 New balance: ${newBalance}`
      );
    }

    const messages = [
      `${viewer.display_name} really caught a ${rarity} ${catch_name} and said “run me my coins” 💅 +${rewardAmount} | Balance: ${newBalance}`,
      `${viewer.display_name} pulled a ${rarity} ${catch_name}… okay main character energy 😭 +${rewardAmount} | Balance: ${newBalance}`,
      `${viewer.display_name} caught a ${rarity} ${catch_name} and now they think they’re better than us +${rewardAmount} 💀 | Balance: ${newBalance}`,
      `${viewer.display_name} with a ${rarity} ${catch_name}?? oh they’re eating today +${rewardAmount} | Balance: ${newBalance}`,
      `${viewer.display_name} got a ${rarity} ${catch_name}… don’t get cocky now +${rewardAmount} 👀 | Balance: ${newBalance}`,
      `${viewer.display_name} caught a ${rarity} ${catch_name} and immediately became insufferable +${rewardAmount} 💅 | Balance: ${newBalance}`,
      `${viewer.display_name} said “watch this” and pulled a ${rarity} ${catch_name} +${rewardAmount} 😭 | Balance: ${newBalance}`,
      `${viewer.display_name} caught a ${rarity} ${catch_name}… yeah okay flex I guess +${rewardAmount} | Balance: ${newBalance}`
    ];

    res.send(messages[Math.floor(Math.random() * messages.length)]);
  } catch (error) {
    res.status(500).send(error.message || 'Fishing reward failed.');
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});