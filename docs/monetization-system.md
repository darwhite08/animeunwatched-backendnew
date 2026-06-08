# Kaiveron — Creator Monetization System (research-backed)

> World-class fan-funding monetization for Kaiveron creators. Grounded in a
> verified deep-research pass (19 confirmed claims, 6 refuted — noted in §8).

## TL;DR — the model the evidence supports

**Fan-funding is the engine, not ads.** Verified: ad-share RPMs at niche scale
are $0.02–0.30 (unviable). Memberships + tips + paid unlocks at a **90/10 split**
(creator keeps 90%) match Substack (10% fee) and **pixivFANBOX (10% all-ages /
12.9% R-18)** — the closest anime/Japan precedent. So:

| Stream | What | Split | Notes |
|---|---|---|---|
| **Memberships** | Monthly creator tiers (e.g. ¥/$ 3/5/10) fans subscribe to | **90 / 10** | recurring; the core |
| **Tips** | One-off "Super Thanks"-style tips on any content/profile | **90 / 10** | impulse; no commitment |
| **Paid unlocks** | Paywall a premium blog/list/guide; pay-per-unlock or bundled in a tier | **90 / 10** | leverages existing Blogs |
| ~~Ad revenue share~~ | — | — | **excluded** — unviable at niche scale (verified) |
| Brand/sponsorship marketplace | (Phase 3) connect creators ↔ anime brands, platform takes a cut | TBD | later |

Platform's 10% covers payment-processor fees (~2.9%+30¢) + infra + margin.
(Optionally absorb processor fees into the 10%, or pass them through — pick at launch.)

## §1 Eligibility & anti-abuse (YPP-style gate)

Monetization is **gated**, not open to everyone (verified: YPP requires 1,000
subs + 4,000 watch-hours; gate + exclude bot traffic). Kaiveron-scaled tiers:

```
Eligible to monetize when ALL:
  • ≥ 100 followers
  • ≥ 200 reputation        (existing gamification signal; already gates club creation)
  • account age ≥ 30 days
  • clean standing          (not banned/shadow-banned, no open severe reports)
  • completed payout onboarding (KYC + tax form via Stripe Connect)
```
**Anti-abuse / payout integrity:** exclude self-follows, blocked/bot accounts,
and refunded/charged-back transactions from earnings; the unique-user + per-user
cap machinery from the trending engine is reused to discount gamed engagement.
Hold new earnings for a **7-day rolling window** before they become payable
(covers refunds/chargebacks).

## §2 Payout stack (verified)

- **Primary: Stripe Connect Express.** Hosted onboarding does KYC/AML + collects
  **W-8/W-9 tax forms**; supports **programmatic payout-blocking** until tax
  forms are submitted; Stripe (or platform) files 1099s. We control pricing →
  **the platform is the 1099 filer**.
- **⚠️ Critical gap:** Stripe Connect **cannot self-serve payouts to India or
  Japan** (through Feb 2026). Kaiveron is India-based and anime creators skew
  Japan — so a **secondary rail is mandatory**: **PayPal Payouts** (broad
  global reach incl. India/Japan) or **Wise/Tipalti**. Architecture abstracts
  the rail behind a `PayoutProvider` interface; creator's country routes to the
  right one.
- **Thresholds/schedule:** min payout **$25**, monthly (manual "request payout"
  once eligible), 7-day hold on new earnings. Multi-currency display; settle in
  the creator's currency.
- **Tax (US-centric in research; India/Japan TBD):** 1099-NEC/K via Stripe;
  India GST/TDS + Japan consumption tax/Qualified-Invoice are open compliance
  items to confirm with an accountant before enabling those markets.

## §3 Data model (Prisma)

```
CreatorProfile      monetization status/eligibility per user (isEligible, status,
                    payoutCountry, defaultCurrency)
CreatorTier         a membership tier (creatorId, name, priceCents, currency, perks, active)
CreatorMembership   a fan's active subscription to a tier (fanId, creatorId, tierId,
                    status, currentPeriodEnd, provider refs)
Tip                 one-off tip (fromUserId, toCreatorId, amountCents, contentRef?)
ContentUnlock       a fan's paid unlock of a specific blog/list (userId, targetType, targetId)
CreatorEarning      append-only ledger: every gross inflow → fee → platform cut → net,
                    with source (membership|tip|unlock), status (pending|available|paid|refunded)
PayoutAccount       Stripe Connect (or PayPal) account ref + onboarding/tax status
Payout              a payout request: amountCents, provider, status, period, providerRef
```
`CreatorEarning` is the **single source of truth** (Patreon-style funnel):
`gross → processorFee → platformFee(10%) → net`. Balance = sum(net where
status=available). Everything money-related is an immutable ledger row.

## §4 Creator Studio — Revenue tab (verified IA)

YouTube Studio 6-tab IA: **Overview · Content · Reach · Engagement · Audience ·
Revenue**. We already built Overview/Content/Audience; add **Revenue**:

- **Earnings funnel (Patreon-style):** gross → declines/refunds → processor fees
  → platform fee → **net Creator Balance**.
- **KPIs:** this-month net, active members, MRR, tips, available-to-pay-out.
- **Subscribers:** count, new, churned, **net growth + paid retention cohort**
  (Substack Retention tab — verified).
- **Payouts:** balance, "Request payout", payout history, onboarding status.
- **Net vs gross** always distinguished (verified YouTube practice).

## §5 What ships when (rollout)

1. **Phase 1 (no live payments):** schema + earnings ledger + 90/10 split math +
   eligibility engine + tier CRUD + Revenue-tab read APIs + studio Revenue UI.
   Fully testable with simulated transactions. *(this PR)*
2. **Phase 2 (live payments — needs your Stripe + PayPal accounts):** Stripe
   Connect Express onboarding + Checkout for memberships/tips + webhooks →
   ledger; PayPal Payouts secondary rail; payout requests. Behind `STRIPE_*` /
   `PAYPAL_*` env, inert until keys exist.
3. **Phase 3:** paid content unlocks at scale, sponsorship marketplace, virtual
   goods/badges, AI-content disclosure rules.

## §6 Where it lives (decided)

Separate subdomain **creator-studio.kaiveron.com** (the `studio.youtube.com`
pattern) — new standalone Next.js app (`kaiveron-creator-studio`), shared
backend, **cross-subdomain SSO via the existing `.kaiveron.com` refresh cookie**
(already supported by the backend; no changes needed). The research didn't
resolve subdomain-vs-embedded conclusively, but the subdomain cleanly isolates
the heavier "pro" bundle from the consumer app and matches every major platform.

## §7 Honesty — refuted / unverified (do NOT cite)

Refuted by the research and excluded from this design: specific Patreon splits
(88–95%), Patreon "$1B paid"/4-step funnel specifics, Twitch Partner Plus 70/30,
Kick 95%, and "platforms purge 20–40% of viewers." Twitch/Kick economics remain
unverified. India GST/TDS + Japan consumption-tax specifics were **not**
researched — confirm with an accountant before enabling those payout markets.
Stripe's India/Japan payout exclusion and W-8/W-9 product status are time-
sensitive (as of early 2026).

## §8 Verified sources
pixivFANBOX fees · Substack metrics guide · YouTube Studio analytics + metrics
API + YPP eligibility · Stripe Connect cross-border payouts + W-8/W-9 + tax-
reporting docs. (Full list in the desktop research report.)
