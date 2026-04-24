require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get('/', (req, res) => {
  res.send('Shared Coins Backend is running');
});

app.post('/add-coins', async (req, res) => {
  const apiKey = req.headers['x-api-key'];

  if (apiKey !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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

  const { data, error } = await supabase
    .from('coin_balances')
    .select('balance')
    .eq('twitch_user_id', user_id)
    .single();

  if (error) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ balance: data.balance });
});

app.get('/coins/:username', async (req, res) => {
  const username = req.params.username.toLowerCase();

  const { data: viewer, error: viewerError } = await supabase
    .from('viewers')
    .select('twitch_user_id')
    .eq('twitch_login', username)
    .single();

  if (viewerError || !viewer) {
    return res.json({ balance: 0 });
  }

  const { data: balanceData, error: balanceError } = await supabase
    .from('coin_balances')
    .select('balance')
    .eq('twitch_user_id', viewer.twitch_user_id)
    .single();

  if (balanceError || !balanceData) {
    return res.json({ balance: 0 });
  }

  res.json({ balance: balanceData.balance });
});

app.get('/coins-message/:username', async (req, res) => {
  const username = req.params.username.toLowerCase();

  const { data: viewer } = await supabase
    .from('viewers')
    .select('twitch_user_id, display_name')
    .eq('twitch_login', username)
    .single();

  if (!viewer) {
    return res.send(`${username} has 0 coins… broke behavior 😭`);
  }

  const { data: balanceData } = await supabase
    .from('coin_balances')
    .select('balance')
    .eq('twitch_user_id', viewer.twitch_user_id)
    .single();

  const balance = balanceData?.balance || 0;
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

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});