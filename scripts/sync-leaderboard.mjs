import fs from 'node:fs';
import path from 'node:path';

const FIREBASE_DB_URL = 'https://dsssbexamportal-default-rtdb.asia-southeast1.firebasedatabase.app';
const TESTS_LIST_PATH = path.resolve('tests/tests_list.json');
const LEADERBOARD_PATH = path.resolve('tests/leaderboard.json');

// Matches index.html hash function identically (keeps phone numbers private)
function makePublicUidHash(uid) {
    const str = 'pyq_lb_v1_' + String(uid || 'guest').trim().toLowerCase();
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return 'u_' + (hash >>> 0).toString(36);
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.json();
}

async function loadTestsMeta() {
    if (fs.existsSync(TESTS_LIST_PATH)) {
        try {
            const raw = JSON.parse(fs.readFileSync(TESTS_LIST_PATH, 'utf8'));
            if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
                return raw;
            }
        } catch (e) {}
    }
    const authParam = process.env.FIREBASE_AUTH ? `?auth=${encodeURIComponent(process.env.FIREBASE_AUTH)}` : '';
    const remote = await fetchJson(`${FIREBASE_DB_URL}/dsssb_tests_db.json${authParam}`);
    return remote || {};
}

async function run() {
    const authSuffix = process.env.FIREBASE_AUTH ? `&auth=${encodeURIComponent(process.env.FIREBASE_AUTH)}` : '';
    const resultsUrl = `${FIREBASE_DB_URL}/dsssb_results_live.json?orderBy=%22$key%22&limitToLast=5000${authSuffix}`;

    const [rawResults, testsMeta] = await Promise.all([
        fetchJson(resultsUrl),
        loadTestsMeta()
    ]);

    const perTestBest = {};
    const userMeta = {};
    let totalSubmissions = 0;

    Object.values(rawResults || {}).forEach(r => {
        if (!r || !r.testId || r.score === undefined || r.score === null) return;
        const score = parseFloat(r.score);
        if (Number.isNaN(score)) return;

        totalSubmissions++;
        const rawUid = String(r.userId || r.id || r.name || 'guest').trim();
        if (!rawUid || rawUid === 'guest') return;

        const safeName = String(r.name || 'Student').trim().slice(0, 32) || 'Student';
        const timeTaken = Math.max(0, parseInt(r.timeTaken || r.time, 10) || 0);
        const acc = Math.max(0, Math.min(100, parseFloat(r.accuracy) || 0));
        const ts = Number(r.timestamp) || 0;

        if (!userMeta[rawUid] || ts >= userMeta[rawUid].latestTs) {
            userMeta[rawUid] = {
                name: safeName,
                hash: makePublicUidHash(rawUid),
                latestTs: ts
            };
        }

        if (!perTestBest[r.testId]) perTestBest[r.testId] = {};
        const prev = perTestBest[r.testId][rawUid];

        if (!prev || score > prev.s || (score === prev.s && timeTaken > 0 && (prev.t === 0 || timeTaken < prev.t))) {
            perTestBest[r.testId][rawUid] = {
                h: makePublicUidHash(rawUid),
                n: safeName,
                s: parseFloat(score.toFixed(2)),
                t: timeTaken,
                a: Math.round(acc)
            };
        }
    });

    const testsLeaderboard = {};
    const globalAgg = {};

    Object.keys(perTestBest).forEach(testId => {
        const tInfo = testsMeta[testId] || {};
        const maxMarks = parseFloat(tInfo.marks) || ((parseInt(tInfo.qs, 10) || 20) * (parseFloat(tInfo.pm) || 1));

        const entries = Object.entries(perTestBest[testId]).map(([rawUid, entry]) => {
            if (!globalAgg[rawUid]) globalAgg[rawUid] = { totalScore: 0, totalMax: 0, count: 0 };
            globalAgg[rawUid].totalScore += Math.max(0, entry.s);
            globalAgg[rawUid].totalMax += (maxMarks > 0 ? maxMarks : 20);
            globalAgg[rawUid].count += 1;
            return entry;
        });

        entries.sort((a, b) => {
            if (b.s !== a.s) return b.s - a.s;
            if (a.t === 0 && b.t === 0) return 0;
            if (a.t === 0) return 1;
            if (b.t === 0) return -1;
            return a.t - b.t;
        });

        testsLeaderboard[testId] = {
            total: entries.length,
            top: entries.slice(0, 25)
        };
    });

    const globalList = Object.keys(globalAgg).map(rawUid => {
        const g = globalAgg[rawUid];
        const meta = userMeta[rawUid] || { name: 'Student', hash: makePublicUidHash(rawUid) };
        const pct = g.totalMax > 0 ? Math.max(0, Math.min(100, (g.totalScore / g.totalMax) * 100)) : 0;
        return {
            h: meta.hash,
            n: meta.name,
            p: parseFloat(pct.toFixed(1)),
            c: g.count,
            ts: parseFloat(g.totalScore.toFixed(1))
        };
    });

    globalList.sort((a, b) => {
        if (b.p !== a.p) return b.p - a.p;
        if (b.c !== a.c) return b.c - a.c;
        return b.ts - a.ts;
    });

    const corePayload = {
        totalStudents: globalList.length,
        totalSubmissions,
        global: globalList.slice(0, 50),
        tests: testsLeaderboard
    };

    // Skip rewriting if rankings haven't changed since last run
    if (fs.existsSync(LEADERBOARD_PATH)) {
        try {
            const existing = JSON.parse(fs.readFileSync(LEADERBOARD_PATH, 'utf8'));
            const prevCore = {
                totalStudents: existing.totalStudents,
                totalSubmissions: existing.totalSubmissions,
                global: existing.global,
                tests: existing.tests
            };
            if (JSON.stringify(prevCore) === JSON.stringify(corePayload)) {
                console.log('No new rankings detected. Skipping file update.');
                return;
            }
        } catch (e) {}
    }

    const finalPayload = {
        updatedAt: Date.now(),
        ...corePayload
    };

    fs.mkdirSync(path.dirname(LEADERBOARD_PATH), { recursive: true });
    fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(finalPayload, null, 2));
    console.log(`Updated leaderboard.json (${globalList.length} students across ${Object.keys(testsLeaderboard).length} tests).`);
}

run().catch(err => {
    console.error('Leaderboard sync failed:', err);
    process.exit(1);
});
