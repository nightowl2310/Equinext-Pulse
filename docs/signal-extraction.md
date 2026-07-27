# Getting a Signal Out of Participant OI

*Everything below is computed from our own `nse_data.db` — 2,604 trading days of participant OI
(2016-01-01 → 2026-07-24) joined to 2,601 days of NIFTY 50 prices. No numbers are illustrative.*

---

## 0. The vocabulary you need (only 5 words)

| Word | Plain meaning |
|---|---|
| **Open Interest (OI)** | How many futures/options contracts are currently *alive* — bets that have been opened and not yet closed. Not volume. Volume = how many trades happened today; OI = how many bets are still standing. |
| **Long / Short** | Long = betting price goes **up**. Short = betting price goes **down**. |
| **Net** | Long minus Short. Positive = the group is leaning bullish. Negative = leaning bearish. |
| **FII / DII / Client / Pro** | Foreign funds / Indian mutual & insurance funds / retail people like you and me / brokers' own trading desks. |
| **Forward return** | "If I buy today, what happens over the next N days?" This is the only thing that decides whether a signal is real. |

---

## 1. The first thing to understand: this is a zero-sum table

From the latest day in our DB (2026-07-24):

```
FII net    = -270,847
Client net = +176,498
DII net    =  +65,128
Pro net    =  +29,221
            -----------
SUM        =        0   ← exactly zero
```

Every futures contract has a buyer *and* a seller. So the four columns **must** add to zero.

**Why this matters:** measured over 10 years of our data, the correlation between Client net and
FII net is **−0.92**. That is nearly a perfect mirror.

> If someone tells you "FII are short AND retail are long, that's two bearish confirmations!" —
> they are counting the same fact twice. It's one piece of information wearing two hats.

Practical rule: **pick FII as your signal, ignore Client as a separate input.**

---

## 2. Level vs Change — the two questions you can ask

Your dashboard already splits every chart into these two, and they answer different questions:

- **Net (level)** = *where the FIIs are standing right now.* Slow, structural.
- **Δ Net (change)** = *what the FIIs did today.* Fast, noisy.

We tested both. Result up front: **the level carries information, the daily change carries almost none.**

```
FII net index futures DAILY CHANGE → next 20 days of NIFTY
  bottom 20% of changes  →  +0.81%
  top    20% of changes  →  +1.02%      ← basically no separation
```

So Δ Net is a nice picture but a weak signal. Don't build on it.

---

## 3. Raw numbers are useless. Ranks are usable.

"FII net is −2,70,847" means nothing on its own. Is that a lot? Compared to what?

The single highest-value transformation in this whole project is **percentile ranking**:

> Take today's FII net. Compare it to the last 250 trading days (≈1 year).
> What fraction of those days was it *above*? That's your 0–100 score.

Today: **2nd percentile.** FIIs are more bearishly positioned than on 98% of the last year's days.
*That* is a sentence a human can act on.

```python
pct = fii_net.rolling(250, min_periods=250).apply(lambda x: (x.iloc[-1] > x).mean())
```

---

## 4. The honest test — and the trap that fakes results

**The test:** for every day, record the signal state → measure what NIFTY did over the next
1/5/10/20 days → bucket by state → compare against the base rate of all days.

Base rate from our data (what you get by doing nothing):

```
 1d: +0.048%   (up 54.2% of days)
 5d: +0.247%   (up 57.4%)
20d: +1.018%   (up 63.1%)
```

Any signal has to beat *that*, or it's worthless.

**The trap — lookahead bias.** NSE publishes the participant OI file **after market close (~6 pm)**.
If your backtest buys at *today's close* using today's data, you bought using information that
didn't exist yet. That is time travel and it invents edge that vanishes in real life.

In our code, every forward return is measured **entry = next day's OPEN**:

```python
fwd_n = open.shift(-1-n) / open.shift(-1) - 1
```

---

## 5. What we actually found

### Result A: Direction — no edge. (This kills the popular theory.)

Bucketing by FII net level percentile, 2017–2026:

| FII net percentile | days | next 20d avg |
|---|---|---|
| bottom 20% | 741 | +0.52% |
| 40–60% | 439 | +1.02% |
| top 20% | 362 | +1.56% |

Looks great — high FII positioning → better returns. **But then we broke it:**

```
Year-by-year (does FII-high beat FII-low?):
  2017 OK    2018 FAILS  2019 FAILS  2020 OK (+8.66% gap!)
  2021 OK    2022 FAILS  2023 FAILS  2024 OK
  2025 OK    2026 FAILS (-7.19% gap)

Split-half:  2017-2021 gap +1.89%   |   2021-2026 gap -0.59%   ← reverses
Excluding 2020 entirely:  gap -0.06%   ← the edge is GONE
```

**The entire apparent edge was the March 2020 COVID crash.** One event, dressed up as a
ten-year pattern. Block-bootstrap (which accounts for our overlapping windows) puts the 90%
range at **−0.18% to +1.71%** — it comfortably includes zero.

> **Do not use participant OI to predict which way NIFTY goes.** Our own data says no.

### Result B: Risk — looked great, ALSO died under testing.

Same buckets, but now asking *how rough are the next 20 days* instead of *which way*:

| FII net percentile | daily volatility | avg worst dip | chance of a >5% drop |
|---|---|---|---|
| **bottom 20%** | **1.00** | **−3.21%** | **16.2%** |
| 20–40% | 0.85 | −2.47% | 13.6% |
| 40–60% | 0.79 | −2.12% | 10.3% |
| 60–80% | 0.81 | −1.87% | 9.6% |
| **top 20%** | 0.85 | −2.05% | 9.4% |

This *looks* stronger than Result A — it's monotonic (slides smoothly across buckets, which fake
patterns usually don't) and it survived the era split that killed Result A. I nearly published it
as the headline finding. Then I ran the same 2020-exclusion test that killed Result A:

```
                 bottom 20%                    top 20%
ALL YEARS        vol 1.00  dip -3.21%  drop 16.2%  |  vol 0.85  dip -2.08%  drop  9.7%
EXCLUDING 2020   vol 0.88  dip -2.29%  drop 12.6%  |  vol 0.80  dip -2.23%  drop 10.3%   ← weak
EXCL 2020+2022   vol 0.83  dip -2.03%  drop  7.2%  |  vol 0.80  dip -2.12%  drop  8.7%   ← REVERSES
```

Year-by-year, the "bottom 20% = more crashes" claim holds in 2020, 2021, 2022 — and **fails in
2019 and 2024**. Two crisis years were doing all the work.

**The correct interpretation:** low FII net doesn't *predict* stress, it *accompanies* it. When the
market is already falling, FIIs are already short. That is a **coincident** indicator, not a
leading one — it tells you about now, not about next month. Useful for describing the present,
worthless for forecasting.

*(A second problem to note: in 2025 and 2026 the "top 20%" bucket has **zero** days — FIIs have
been structurally short for two years straight. So a 1-year rolling percentile isn't comparable
across eras the way I assumed.)*

### Result C: The one thing that survived — timing exposure

Rule: hold NIFTY only when FII percentile > 50, else sit in cash.

```
Buy & hold (100% invested) : 11.06%/yr,  worst drawdown -37.8%
FII rule   (39% of days)   :  8.47%/yr,  worst drawdown -17.5%
```

**Do not stop reading here** — this comparison is rigged. Holding cash 61% of the time cuts your
drawdown whether or not your signal knows anything. So we tested it against two honest baselines:

```
constant 39% exposure (no signal at all): 4.53%/yr,  drawdown -16.5%
RANDOM signal, same 39% on-rate, 2000 draws:
    median  4.08%/yr,  median drawdown -23.8%
    5th-95th percentile of CAGR: -0.16%  to  +8.45%
    share of random signals that BEAT the FII rule: 5.0%     ← permutation p-value
```

**Read the drawdown honestly:** the FII rule's −17.5% is *no better* than the −16.5% you'd get by
just permanently keeping 61% in cash. So the "less than half the pain" story is exposure, not skill.

**But the return is where the skill shows.** For the same 39% exposure, the FII rule earned
**8.47%/yr vs 4.08–4.53%** for the no-skill versions — roughly double. Only **5% of 2,000 random
same-exposure signals** matched it. That's a genuine but *marginal* result (p ≈ 0.05 is the very
edge of respectable), and it's before brokerage: the rule flips **15 times a year**.

**Verdict on all three:** direction — no. Risk forecasting — no. Modest skill at choosing *when to
be invested* — yes, barely, and I would not bet real money on it without walk-forward testing.

---

## 6. Why you should NOT lead with the options tabs

Your dashboard shows Client at roughly −7 lakh net index puts. Instinct says "retail is bearish."
Wrong. From the DB (10-year averages):

```
Client index puts:  long 1,711,721  short 1,975,467  → net -263,746
FII    index puts:  long   603,460  short   358,640  → net +244,820
```

Retail is a net **seller** of puts (collecting premium, a mildly bullish/income trade); FIIs are
net **buyers** (paying for crash insurance). The negative number is not bearishness.

Worse: OI counts *contracts*, and one deep-out-of-the-money option is nowhere near one futures
contract in actual market exposure. Adding them up is like adding 1 rupee coins to 500 rupee
notes and calling it "20 pieces of money."

**Index futures first. Options are a later lesson.**

---

## 7. The thing that quietly limits everything

We have 2,604 trading days. That sounds like a lot. It isn't.

```
FII net level, 1-day autocorrelation: 0.986
Half-life: ~50 days
→ effective independent samples ≈ 2,349 / 50 ≈ 47
```

Today's FII net is 98.6% the same as yesterday's — they move a giant book slowly.
So we don't have 2,600 experiments, we have roughly **47**. That's a small class, not a stadium.

This is the direct answer to "is 10 years enough?" — **for slow-moving level signals, 10 years is
about 47 real data points, and that is why Result A collapsed under testing.**

---

## 8. Your checklist for testing any future idea

1. **Rank it** — convert the raw number to a rolling percentile.
2. **Respect publication time** — enter at the NEXT day's open, never today's close.
3. **Compare to the base rate** — beating "+1.02% per 20 days" is the bar.
4. **Is it monotonic?** — should slide smoothly across buckets, not jump around.
5. **Split by era and by year** — if it only works in one period, it's an anecdote.
6. **Remove the single biggest event** (for us, 2020) — does it survive?
7. **Count effective samples**, not raw rows.
8. **Ask about risk, not just direction** — different question, sometimes different answer.
9. **Compare against a random signal with the same exposure.** This is the test that separates
   "my rule is smart" from "my rule just holds cash a lot." It killed two-thirds of Result C.
10. **Is your indicator leading or coincident?** If it only moves *with* the market, it describes
    the present. That's a dashboard, not a forecast.

### The meta-lesson

Both of my first two conclusions looked convincing — good-sized tables, smooth monotonic patterns,
plausible stories. Both were single events (COVID 2020, and the 2022 correction) impersonating
ten-year patterns. **A pattern you haven't attacked is not a finding, it's a hypothesis.**

---

## 9. Where the code lives

- Data: `nse_data.db` → tables `participant_oi` (13,020 rows), `index_prices` (2,601 rows)
- Net futures = `future_index_long − future_index_short`
- Scripts used for this study were run ad-hoc; the reusable core is 4 lines:

```python
net  = long - short
pct  = net.rolling(250, min_periods=250).apply(lambda x: (x.iloc[-1] > x).mean())
fwd  = open.shift(-1-n) / open.shift(-1) - 1
table = fwd.groupby(pd.cut(pct, [0,.2,.4,.6,.8,1.0])).agg(['mean','size'])
```

**Suggested next dashboard feature:** replace the raw big number on the FII card with its
**percentile**, so `-2,70,847` reads as *"FII net: 2nd percentile of the last year — most bearish
positioning in 2 years."* That is a factual description a human can use, and it's honest — unlike a
predictive label, which our own testing above says we haven't earned.

**Do NOT ship a "buy/sell" or "crash risk" badge based on this data.** Sections 5A and 5B are
exactly why.
