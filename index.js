const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, ChannelType } = require("discord.js");
const fetch = globalThis.fetch || require("node-fetch");

const cfgPath = path.join(process.cwd(), "config.json");

if (!fs.existsSync(cfgPath)) {
    console.error("Missing config.json");
    process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

if (!cfg.token || !cfg.guildId) {
    console.error("set token and guildId in config.json");
    process.exit(1);
}

let MESSAGES = [];

if (fs.existsSync("messages.txt")) {
    const raw = fs.readFileSync("messages.txt", "utf8").replace(/\r/g, "");
    const blocks = raw.split(/\n\s*\n/);

    MESSAGES = blocks
        .map(block => {
            const lines = block
                .split("\n")
                .map(line => line.replace(/\s+$/g, ""));
            return lines.join("\n").trim();
        })
        .filter(Boolean);
} else {
    MESSAGES = [];
}

const webhooksFile = cfg.webhooksFile || "webhooks.txt";
const scanEveryMs = Number(cfg.scanEveryMs) || 5000;
const desiredPerChannel = Number(cfg.desiredPerChannel) || 2;
const sendDelayMin = Number(cfg.sendDelayMin) || 300;
const sendDelayMax = Number(cfg.sendDelayMax) || 800;
const webhookBaseName = cfg.webhookName || "autowebhook";
const createBurst = Number(cfg.createBurst) || 25;
const burstWindowMs = Number(cfg.burstWindowMs) || 10000;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

const registry = new Map();

function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomMessage() {
    return MESSAGES.length
        ? MESSAGES[Math.floor(Math.random() * MESSAGES.length)]
        : "test";
}

function persistWebhooks() {
    try {
        const lines = Array.from(registry.values()).map(w => w.url);
        fs.writeFileSync(webhooksFile, lines.join("\n"), "utf8");
        console.log(`Saved ${lines.length} webhook(s) to ${webhooksFile}`);
    } catch (e) {
        console.error("Failed to persist webhooks:", e.message || e);
    }
}

async function createWebhook(channel, name) {
    try {
        const wh = await channel.createWebhook({ name });
        if (!wh || !wh.token) return null;

        const url = `https://discord.com/api/webhooks/${wh.id}/${wh.token}`;
        console.log(`Created webhook in #${channel.name} -> ${wh.id}`);

        return {
            id: wh.id,
            token: wh.token,
            url,
            channelId: channel.id
        };
    } catch (err) {
        console.warn(
            `Cannot create webhook in channel ${channel.id}: ${err.message || err}`
        );
        return null;
    }
}

async function fetchChannelWebhooks(channel) {
    try {
        const hooks = await channel.fetchWebhooks();
        const arr = [];

        for (const [, h] of hooks) {
            if (!h.token) continue;
            arr.push({
                id: h.id,
                token: h.token,
                url: `https://discord.com/api/webhooks/${h.id}/${h.token}`,
                channelId: channel.id
            });
        }

        return arr;
    } catch (err) {
        console.warn(
            `Failed fetching webhooks for channel ${channel.id}: ${err.message || err}`
        );
        return [];
    }
}

async function ensureWebhooksForGuild() {
    const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);

    if (!guild) {
        console.error("Guild not found or bot not in guild:", cfg.guildId);
        return;
    }

    const channelsMap = await guild.channels.fetch();
    let totalMissing = 0;
    const channelMissing = [];

    for (const [, channel] of channelsMap) {
        if (channel.type !== ChannelType.GuildText) continue;

        const existing = await fetchChannelWebhooks(channel);

        for (const ex of existing) {
            if (!registry.has(ex.url)) {
                registry.set(ex.url, { ...ex, loopRunning: false });
            }
        }

        const already = existing.length;

        if (already < desiredPerChannel) {
            const missing = desiredPerChannel - already;
            totalMissing += missing;
            channelMissing.push({ channel, missing });
        }
    }

    if (totalMissing === 0) {
        persistWebhooks();
        return;
    }

    const starts = Math.min(totalMissing, createBurst);
    const spacingMs = Math.max(1, Math.floor(burstWindowMs / starts));

    console.log(
        `Need to create ${totalMissing} webhooks. Scheduling ${starts} starts over ${burstWindowMs}ms (spacing ${spacingMs}ms).`
    );

    const createPlan = [];

    for (const { channel, missing } of channelMissing) {
        for (let i = 0; i < missing; i++) {
            createPlan.push(channel);
        }
    }

    const planThisBurst = createPlan.slice(0, starts);
    const creationPromises = [];

    for (let i = 0; i < planThisBurst.length; i++) {
        const channel = planThisBurst[i];
        const delayStart = i * spacingMs;

        const p = (async (ch, waitMs) => {
            await sleep(waitMs);
            try {
                const created = await createWebhook(ch, webhookBaseName);
                if (created) {
                    registry.set(created.url, {
                        ...created,
                        loopRunning: false
                    });
                }
            } catch (err) {
                console.warn(
                    `Error creating scheduled webhook for channel ${ch.id}: ${err?.message || err}`
                );
            }
        })(channel, delayStart);

        creationPromises.push(p);
    }

    await Promise.allSettled(creationPromises);
    persistWebhooks();
}

async function postWebhook(url, content) {
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content })
        });

        if (res.status === 429) {
            let data;
            try {
                data = await res.json();
            } catch {}

            const wait = data?.retry_after
                ? Math.ceil(data.retry_after * 1000)
                : 1000;

            console.warn(`Rate limited on webhook, waiting ${wait}ms`);
            await sleep(wait);
            return { ok: false, status: 429 };
        }

        return { ok: res.ok, status: res.status, res };
    } catch (err) {
        console.error("Webhook POST failed:", err.message || err);
        return { ok: false, status: 0 };
    }
}

async function webhookLoop(webhook) {
    if (!webhook || !webhook.url) return;

    webhook.loopRunning = true;
    const url = webhook.url;

    while (true) {
        const msg = randomMessage();
        const result = await postWebhook(url, msg);

        if (result.status === 404 || result.status === 401) {
            console.warn(
                `Webhook ${url} invalid (status ${result.status}). Removing.`
            );
            registry.delete(url);
            persistWebhooks();
            break;
        }

        if (result.ok) {
            console.log(`Sent via webhook ${url}: ${msg}`);
        }

        await sleep(randInt(sendDelayMin, sendDelayMax));
    }
}

function spawnLoopsForRegistry() {
    for (const [url, wh] of registry.entries()) {
        if (!wh.loopRunning) {
            wh.loopRunning = true;
            webhookLoop(wh).catch(err => {
                console.error("Webhook loop error:", err?.message || err);
                if (registry.has(url)) {
                    registry.get(url).loopRunning = false;
                }
            });
        }
    }
}

async function monitorLoop() {
    while (true) {
        try {
            await ensureWebhooksForGuild();
            spawnLoopsForRegistry();
        } catch (err) {
            console.error("Monitor error:", err?.message || err);
        }
        await sleep(scanEveryMs);
    }
}

client.once("ready", async () => {
    console.log("Client ready. Scanning guild and preparing webhooks");
    await ensureWebhooksForGuild();
    spawnLoopsForRegistry();
    monitorLoop().catch(e =>
        console.error("monitorLoop crashed:", e)
    );
});

client.on("error", err =>
    console.error("Discord client error:", err)
);

client.login(cfg.token).catch(err => {
    console.error("Login failed:", err?.message || err);
    process.exit(1);
});

process.on("SIGINT", async () => {
    console.log("Shutting down.");
    for (const [, wh] of registry.entries()) {
        wh.loopRunning = false;
    }
    await sleep(300);
    process.exit(0);
});

