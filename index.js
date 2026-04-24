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

async function getViewerByUsername(username) {
  const cleanUsername = username.replace('@', '').toLowerCase();

  const { data, error } = await supabase
    .from('viewers')
    .select('twitch_user_id, twitch_login, display_name')
    .eq('twitch_login', cleanUsername)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
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
    p_source_channel_id: sourceChannelId || 'manual_admin',
    p_source_channel_name: sourceChannelName || 'Admin Command',
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

  if (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true });
});

app.get('/balance/:user_id', async (req, res) => {
  const { user_id } = req.params;

  const balance = await getBalanceByUserId(user_id);

  res.json({ balance });
});

app.get('/coins/:username', async (req, res) => {
  const viewer = await getViewerByUsername(req.params.username);

  if (!viewer) {
    return res.json({ balance: 0 });
  }

  const balance = await getBalanceByUserId(viewer.twitch_user_id);

  res.json({ balance });
});

app.get('/coins-message/:username', async (req, res) => {
  const username = req.params.username.toLowerCase();
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

  const message = messages[Math.floor(Math.random() * messages.length)];
  res.send(message);
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

  if (!viewer) {
    return res.status(404).send(`${target_username} is not in the coin bank yet.`);
  }

  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    return res.status(400).send(`Amount must be a positive number.`);
  }

  const error = await addCoinTransaction({
    viewer,
    amount: coinAmount,
    reason: `admin add by ${admin_username || 'unknown admin'}`,
    sourceChannelId: source_channel_id,
    sourceChannelName: source_channel_name,
    eventId: `admin_add_${randomUUID()}`
  });

  if (error) {
    console.error(error);
    return res.status(500).send(`Could not add coins: ${error.message}`);
  }

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

  if (!viewer) {
    return res.status(404).send(`${target_username} is not in the coin bank yet.`);
  }

  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    return res.status(400).send(`Amount must be a positive number.`);
  }

  const error = await addCoinTransaction({
    viewer,
    amount: -coinAmount,
    reason: `admin remove by ${admin_username || 'unknown admin'}`,
    sourceChannelId: source_channel_id,
    sourceChannelName: source_channel_name,
    eventId: `admin_remove_${randomUUID()}`
  });

  if (error) {
    console.error(error);
    return res.status(500).send(`Could not remove coins: ${error.message}`);
  }

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

  if (!viewer) {
    return res.status(404).send(`${target_username} is not in the coin bank yet.`);
  }

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
    sourceChannelName: source_channel_name,
    eventId: `admin_set_${randomUUID()}`
  });

  if (error) {
    console.error(error);
    return res.status(500).send(`Could not set coins: ${error.message}`);
  }

  res.send(`${viewer.display_name}'s balance is now ${targetAmount} coins. Admin magic happened ✨`);
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});