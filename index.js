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

    // 🚫 Prevent duplicate
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
          `${viewer.display_name} already claimed today's daily from ${streamName} 😭`
        );
      }
      return res.status(500).send(claimError.message);
    }

    // 🧠 STREAK LOGIC
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

    let reward;

    if (streak === 1) reward = 50;
    else if (streak === 2) reward = 60;
    else if (streak === 3) reward = 75;
    else if (streak === 4) reward = 90;
    else if (streak === 5) reward = 110;
    else if (streak === 6) reward = 135;
    else reward = 175;

    await supabase.from('daily_streaks').upsert({
      twitch_user_id: viewer.twitch_user_id,
      source_channel_name: streamName,
      streak_count: streak,
      last_claim_date: today
    });

    const addError = await addCoinTransaction({
      viewer,
      amount: reward,
      reason: `daily streak ${streak}`,
      sourceChannelId: source_channel_id || 'daily',
      sourceChannelName: streamName,
      eventId: `daily_${viewer.twitch_user_id}_${streamName}_${today}_${randomUUID()}`
    });

    if (addError) {
      return res.status(500).send(addError.message);
    }

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    let message;

    if (streak >= 7) {
      message = `${viewer.display_name} is on a ${streak} day streak??? oh they’re committed 💅 +${reward}`;
    } else if (streak >= 4) {
      message = `${viewer.display_name} hit day ${streak}… okay consistency 👀 +${reward}`;
    } else if (streak >= 2) {
      message = `${viewer.display_name} came back for day ${streak} 😌 +${reward}`;
    } else {
      message = `${viewer.display_name} started a streak… let’s see how long this lasts 😭 +${reward}`;
    }

    res.send(`${message} Coins | Balance: ${newBalance}`);

  } catch (error) {
    res.status(500).send(error.message || 'Daily failed.');
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

  res.send(`🏆 Top 5 coin Baddies: ${leaderboard}`);
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
      `${viewer.display_name} really caught a ${rarity} ${catch_name} and said “run me my coins” 💅 +${rewardAmount} | Balance: ${newBalance} Coins`,
      `${viewer.display_name} pulled a ${rarity} ${catch_name}… okay main character energy 😭 +${rewardAmount} | Balance: ${newBalance} Coins`,
      `${viewer.display_name} caught a ${rarity} ${catch_name} and now they think they’re better than us +${rewardAmount} 💀 | Balance: ${newBalance} Coins`,
      `${viewer.display_name} with a ${rarity} ${catch_name}?? oh they’re eating today +${rewardAmount} | Balance: ${newBalance} Coins`,
      `${viewer.display_name} got a ${rarity} ${catch_name}… don’t get cocky now +${rewardAmount} 👀 | Balance: ${newBalance} Coins`,
      `${viewer.display_name} caught a ${rarity} ${catch_name} and immediately became insufferable +${rewardAmount} 💅 | Balance: ${newBalance} Coins`,
      `${viewer.display_name} said “watch this” and pulled a ${rarity} ${catch_name} +${rewardAmount} 😭 | Balance: ${newBalance} Coins`,
      `${viewer.display_name} caught a ${rarity} ${catch_name}… yeah okay flex I guess +${rewardAmount} | Balance: ${newBalance} Coins`
    ];

    res.send(messages[Math.floor(Math.random() * messages.length)]);
  } catch (error) {
    res.status(500).send(error.message || 'Fishing reward failed.');
  }
});

app.post('/event-reward', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const {
      twitch_login,
      display_name,
      event_type,
      sub_tier,
      source_channel_name
    } = req.body;

    const eventType = String(event_type || '').toLowerCase();
    const tier = String(sub_tier || '').toLowerCase();

    let rewardAmount = 0;
    let reason = '';

if (eventType === 'follow') {
  rewardAmount = 25;
  reason = 'new follow';
} else if (eventType === 'first_time_chat') {
  rewardAmount = 15;
  reason = 'first time chatter';
} else if (eventType === 'sub') {
  if (tier.includes('3000') || tier.includes('3')) {
    rewardAmount = 500;
    reason = 'tier 3 sub';
  } else if (tier.includes('2000') || tier.includes('2')) {
    rewardAmount = 250;
    reason = 'tier 2 sub';
  } else {
    rewardAmount = 100;
    reason = 'tier 1 or prime sub';
  }
}
    if (rewardAmount <= 0) {
      return res.send('');
    }

    const viewer = await getOrCreateViewer({
      twitch_login,
      display_name
    });

    const error = await addCoinTransaction({
      viewer,
      amount: rewardAmount,
      reason,
      sourceChannelId: eventType,
      sourceChannelName: source_channel_name || 'Stream Event',
      eventId: `event_${eventType}_${viewer.twitch_user_id}_${Date.now()}_${randomUUID()}`
    });

    if (error) {
      return res.status(500).send(`Event reward failed: ${error.message}`);
    }

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    const messages = {
      follow: [
        `${viewer.display_name} followed and got ${rewardAmount} coins 💅 welcome in`,
        `${viewer.display_name} hit follow and immediately got paid. Icon behavior +${rewardAmount} coins`
      ],
      first_time_chat: [
        `${viewer.display_name} said hi for the first time and got ${rewardAmount} coins 😭 welcome in`,
        `${viewer.display_name} entered chat and the economy noticed +${rewardAmount} coins`
      ],
      sub: [
        `${viewer.display_name} subscribed and got ${rewardAmount} coins 💅 thank youuuu`,
        `${viewer.display_name} subbed and got paid because we love commitment +${rewardAmount} coins`
      ]
    };

    const pool = messages[eventType] || [
      `${viewer.display_name} earned ${rewardAmount} coins`
    ];

    const message = pool[Math.floor(Math.random() * pool.length)];

    res.send(`${message} | Balance: ${newBalance} Coins`);
  } catch (error) {
    res.status(500).send(error.message || 'Event reward failed.');
  }
});

app.post('/gamble', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const {
      twitch_login,
      display_name,
      amount,
      source_channel_name
    } = req.body;

    const betAmount = parseInt(amount, 10);

    if (!Number.isFinite(betAmount) || betAmount <= 0) {
      return res.send(`Be serious 😭 use !gamble 50`);
    }

    const viewer = await getOrCreateViewer({
      twitch_login,
      display_name
    });

    const currentBalance = await getBalanceByUserId(viewer.twitch_user_id);

    if (currentBalance < betAmount) {
      return res.send(`${viewer.display_name} tried to gamble ${betAmount} coins with only ${currentBalance}… be so serious 😭`);
    }

    const roll = Math.random();

    let winnings = 0;
    let resultMessage = '';

    // 💀 LOSE (50%)
    if (roll < 0.5) {
      winnings = -betAmount;

      const messages = [
        `${viewer.display_name} lost ${betAmount} coins… yeah that felt predictable 💀`,
        `${viewer.display_name} really thought this would go well 😭 -${betAmount} coins`,
        `${viewer.display_name} gambled ${betAmount} coins and immediately regretted it, -${betAmount}`,
        `${viewer.display_name} lost ${betAmount} coins. Financial decisions were made.`
      ];

      resultMessage = messages[Math.floor(Math.random() * messages.length)];
    }

    // 😭 SMALL WIN (30%)
    else if (roll < 0.8) {
      winnings = Math.floor(betAmount * 0.5);

      const messages = [
        `${viewer.display_name} barely survived and got +${winnings} coins… not impressive but okay 😭`,
        `${viewer.display_name} made +${winnings} coins. A win is a win I guess`,
        `${viewer.display_name} walked away with +${winnings} coins… humble moment`,
        `${viewer.display_name} got +${winnings} coins. We’ll allow it 😌`
      ];

      resultMessage = messages[Math.floor(Math.random() * messages.length)];
    }

    // 💅 BIG WIN (17%)
    else if (roll < 0.97) {
      winnings = betAmount;

      const messages = [
        `${viewer.display_name} doubled it?? okay relax 💅 +${winnings} coins`,
        `${viewer.display_name} won +${winnings} coins… don’t get bold now`,
        `${viewer.display_name} really said “watch this” and won +${winnings} 😭`,
        `${viewer.display_name} got +${winnings} coins and now thinks they’re better than us`
      ];

      resultMessage = messages[Math.floor(Math.random() * messages.length)];
    }

    // 🔥 JACKPOT (3%)
    else {
      winnings = betAmount * 3;

      resultMessage = `🎰 ${viewer.display_name} HIT THE JACKPOT??? HELLO??? | Won ${winnings} Coins 💅🔥`;
    }

    const error = await addCoinTransaction({
      viewer,
      amount: winnings,
      reason: `gamble ${betAmount}`,
      sourceChannelId: 'gamble',
      sourceChannelName: source_channel_name || 'Gamble Command',
      eventId: `gamble_${viewer.twitch_user_id}_${Date.now()}_${randomUUID()}`
    });

    if (error) {
      return res.status(500).send(`Gamble failed: ${error.message}`);
    }

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    res.send(`${resultMessage} | Balance: ${newBalance} Coins`);

  } catch (error) {
    res.status(500).send(error.message || 'Gamble failed.');
  }
});

app.post('/work', async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const {
      twitch_login,
      display_name,
      source_channel_name
    } = req.body;

    const viewer = await getOrCreateViewer({
      twitch_login,
      display_name
    });

    // 🎲 Base earnings (5–15)
    let earned = Math.floor(Math.random() * 11) + 5;

    // 🎯 3% rare job chance
    const isRare = Math.random() < 0.03;

    // 💅 Normal jobs
    const jobs = [
      "went on feetfinder and sold 2 pics (allegedly)",
      "got paid to flirt with someone’s situationship… good luck with that",
      "clocked in as a delusion specialist… and excelled",
      "worked a shift at the audacity factory… management level",
      "sold confidence they absolutely did not have",
      "ran a business built entirely on vibes… no structure whatsoever",
      "got paid to act like they knew what was going on… they didn’t",
      "worked as a certified drama distributor… again",
      "clocked in as a chaos coordinator… as expected",
      "got paid to escalate a situation… for no reason",
      "did consulting for bad decisions… top client",
      "worked as a professional side-eye giver… critically acclaimed",
      "got paid to be slightly problematic… consistent work",
      "ran a pop-up shop selling pure audacity… sold out instantly",
      "worked as a personal menace for hire… booked and busy",
      "did freelance nonsense… no one stopped them",
      "clocked in as a confidence dealer… overselling heavily",
      "worked as a certified overreactor… award-winning"
    ];

    // 🔥 Rare insane jobs (3%)
    const rareJobs = [
      "accidentally ran the company for 5 minutes",
      "got promoted and immediately abused the power",
      "was legally not supposed to be there but got paid anyway",
      "got paid way too much for doing absolutely nothing",
      "took over the workplace and nobody stopped them",
      "clocked in and became the problem instantly",
      "got paid to leave early and still complained",
      "showed up, did nothing, and still got praised",
      "was the reason HR had a meeting later",
      "got paid to fix a problem they caused"
    ];

    const endings = [
      "… impressive, I guess 💅",
      "… not too much now 😭",
      "… we’re watching you 👀",
      "… okay miss thing",
      "… suddenly they’re loud",
      "… that’s a choice"
    ];

    let job;

    if (isRare) {
      job = rareJobs[Math.floor(Math.random() * rareJobs.length)];

      // 💥 Rare bonus payout
      earned += Math.floor(Math.random() * 11) + 10; // +10–20 bonus
    } else {
      job = jobs[Math.floor(Math.random() * jobs.length)];
    }

    const ending = endings[Math.floor(Math.random() * endings.length)];

    const error = await addCoinTransaction({
      viewer,
      amount: earned,
      reason: isRare ? 'rare work event' : 'worked a shift',
      sourceChannelId: 'work',
      sourceChannelName: source_channel_name || 'Work Command',
      eventId: `work_${viewer.twitch_user_id}_${Date.now()}_${randomUUID()}`
    });

    if (error) {
      return res.status(500).send(`Work failed: ${error.message}`);
    }

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    const msg = isRare
      ? `💼✨ ${viewer.display_name} ${job} and made ${earned} Coins… HELLO??? rare behavior 💅`
      : `💼 ${viewer.display_name} ${job} and made ${earned} Coins ${ending}`;

    res.send(`${msg} | Balance: ${newBalance} Coins`);

  } catch (error) {
    res.status(500).send(error.message || 'Work failed.');
  }
});

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

    const error = await addCoinTransaction({
      viewer,
      amount: -redeemCost,
      reason: `redeem: ${reward_name}`,
      sourceChannelId: 'redeem',
      sourceChannelName: source_channel_name || 'Redeem',
      eventId: `redeem_${viewer.twitch_user_id}_${Date.now()}_${randomUUID()}`
    });

    if (error) {
      return res.status(500).send(error.message);
    }

    const newBalance = await getBalanceByUserId(viewer.twitch_user_id);

    res.send(
      `REDEEM|${reward_name}|${viewer.display_name} redeemed ${reward_name} 💅 -${redeemCost} Coins | Balance: ${newBalance}`
    );

  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});