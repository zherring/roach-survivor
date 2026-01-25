# $ROACH Game - Product Requirements Document

## Overview
A skill-based multiplayer game where players mint roaches, stomp other roaches for $ROACH tokens, and survive as long as possible. Think crypto meets Whack-a-Mole with 90s Nickelodeon gross-out aesthetic.

---

## Core Loop
1. **Mint a roach** (1c - $1, price scales with popularity) to enter the economy
2. **Stomp roaches** to earn $ROACH
3. **Survive** to passively accumulate $ROACH over time
4. **Spend $ROACH** on upgrades/healing or risk losing it
5. **Get stomped** = lose 90% of your $ROACH to the stomper

---

## Gameplay Mechanics

### Stomping (Offense)
- **Click/tap based**, skill-focused
- **Rate-of-fire** limit (not cooldown, but can't infinite-click)
- **Miss penalty**: Roaches scatter (punishes spam, rewards precision)
- **Roaches take 3 hits to kill** (configurable in game logic)
- Stomping speed/ability **NOT affected** by your $ROACH balance
- **Boot hitbox matches visual** - entire boot area squishes, not just cursor point

### Live Cursors / Boots
- **All player boots are visible** to roaches in the room
- Boot shows at **reduced opacity (60%) when hovering**, full opacity on stomp
- **Boots tilt in movement direction** - gives sense of motion/momentum
- **Roaches can see and flee from boots** - adds skill/counterplay
- Creates tension: moving your cursor scatters roaches, requires prediction
- House bot boots are also visible, tilt with movement, and roaches flee from them too

### Roach Control (Defense)
- **Direct control** (WASD/joystick style)
- **Randomized steering element** - hard to steer precisely, adds chaos
- Your roach is always vulnerable while you're in-game

### Room Navigation
- **No teleporting** - must physically steer roach off screen edge to change rooms
- Roach appears on opposite edge of new room
- Room transitions are **risky** - you're vulnerable during movement
- Creates strategic decisions about when/how to flee

### Rubber-band Mechanic
- **More $ROACH = slower roach** (defensive only)
- Creates natural wealth redistribution
- Rich roaches become fat, slow targets
- Encourages spending over hoarding

---

## Health & Healing

### Health System
- Roaches have **3 HP** (configurable)
- Each stomp hit reduces HP by 1
- At 0 HP, roach dies

### Healing
- **Spend $ROACH to heal** - costs $1 per HP restored
- Creates economy sink and survival decisions
- Can't heal at full HP
- Healing is instant

---

## Upgrades & Progression

### Permanent Upgrades (spend $ROACH, keep forever)
- **Boot size** - wider stomp radius ("wide-fit boot")
- **Multi-stomp** - hits multiple spots (mini boots attached to main boot)
- **Rate-of-fire** - faster stomping speed

### Consumables
- **Roach motel traps** - area denial, time-limited

### Art Direction for Upgrades
- 90s Nickelodeon gross-out aesthetic
- Examples: hairy toe upgrade, steel-toed toenail, boot sweat aura
- Ren & Stimpy / Earthworm Jim vibes

---

## Death & Economy

### When Your Roach Dies
- **Lose 90% of your $ROACH**
- **Instant respawn** in same room
- Stomper receives your lost 90%

### Survival Income
- **All roaches earn passive $ROACH** ($0.01 per second) - not just players
- Creates tension: stay alive to earn, but growing balance makes you slower and bigger
- AI roaches accumulate wealth too, making them juicier targets over time
- Roaches visually grow larger as they get richer (up to 3x size at $50+)

### The Spending Imperative
- Holding $ROACH is a liability (makes you slow + lose 90% on death)
- **Upgrades are the "safe bank"** - can't lose what you've already spent
- **Healing** converts $ROACH to survivability
- Economy encourages reinvestment over extraction

### Roach Motel (Banking)
- **Roach Motel** spawns randomly in rooms on a timer (15 second intervals)
- Motel stays visible for 10 seconds before disappearing
- **Timer displays** countdown and which room motel is in
- Player must **stay inside motel for 5 seconds** to bank their $ROACH
- Progress bar/countdown (5, 4, 3, 2, 1) shows above roach while saving
- Green overlay on roach gets darker as saving progresses
- **Banked $ROACH is safe** - not lost on death, displayed separately
- Motel disappears after successful banking
- If player leaves motel early, saving progress resets
- Creates risk/reward: navigate to motel location, survive 5 seconds inside

---

## Multiplayer & Rooms

### Grid System
- **10x10 grid** of rooms (100 total rooms) - prototype uses 2x2
- **Real-time PvP** within each room
- Players **physically navigate** by steering roach off screen edges
- No minimap teleporting - must crawl room to room

### Room Information (visible to players)
- Active stompers count
- Deaths in last 30 minutes
- **Minimap shows current position** but can't click to navigate
- **Wealth indicator**: Yellow bar shows relative wealth in each room
- **Danger indicator**: Red "!" marks show house bot count per room

### Cat-and-Mouse Dynamic
- Rich slow roaches flee to quiet rooms
- Stompers hunt for rooms with juicy targets
- Room transitions are risky moments
- Creates emergent gameplay across the grid

---

## House Mechanics

### House Roaches
- Exist as baseline targets (gray roaches, yellow when rich)
- **100% of rewards go to stomper** (not house)
- House uses mint revenue to spawn more roaches
- **Respawn after death** - new roaches spawn 5-10 seconds after one dies
- AI roaches earn passive income and grow over time like players

### House Bots (AI Stompers)
- **Visible red boots** that roam and stomp
- Hunt roaches (prefer rich/yellow ones)
- Keep pressure on idle roaches
- Add chaos and prevent pure camping
- **Roaches flee from house bots** just like player boots
- **Wealth attracts boots**: Number of house bots scales with total room wealth
  - Formula: 1 house bot per $10 of total roach wealth in the room
  - Maximum 5 house bots per room
  - Bots spawn/despawn dynamically as wealth changes
  - Creates natural danger scaling - rich rooms become hunting grounds

### Anonymous Players
- Can stomp without signing in
- All rewards go to house (used to spawn more roaches)
- Must mint a roach to earn $ROACH

---

## Tokenomics ($ROACH via Vibecoins)

### Revenue Split (on mint/purchase)
- **10% to team** (vesting over time)
- **90% locked in LP forever** (anti-rug, permanent liquidity)

### Withdrawal Mechanic
- **Timelock on withdrawals** (n minutes/hours/days - TBD)
- During timelock, your roach is **still playing and vulnerable**
- **If stomped during timelock = lose everything** (including pending withdrawal)
- Must actively steer your roach to survive the withdrawal period
- Incentivizes spending on upgrades over cashing out

### Economy Flow
- Player stomps roach → gets victim's 90%
- Victim respawns with 10%
- Survival → passive $ROACH accumulation
- Spending → permanent upgrades (safe value storage) or healing
- Withdrawal → risky, must survive timelock

---

## Platform

- **Web-first**
- **Mobile-responsive** (must work on mobile devices)
- Click/tap mechanics work for both

---

## Art Style

- **Pixel aesthetic** - sharp corners, no rounded elements
- **90s Nickelodeon gross-out cartoon** inspiration
- Ren & Stimpy, Earthworm Jim vibes
- Grotesque, absurd, sweaty, veiny, hilarious
- NOT sleek crypto-bro vibes

### Visual Elements (from prototype)
- **Sprite-based roaches** using `game-sprite.png` atlas with idle, crawl, hit, and dead states
- **Roaches rotate** to face their movement direction (smooth 45° tilts)
- **Roaches scale with wealth** - 1x at $0 up to 3x at $50+ (visual size increase)
- **Cyan tinted roach** = player's roach
- **Yellow/gold tinted roach** = rich roaches ($1+)
- **Red arrow indicator** = always points down at player's roach (z-index above everything)
- **Green boot** = player's stomp cursor (60% opacity hover, tilts with movement)
- **Red boots** = house bot stompers (tilt in movement direction)
- **Green splat** = dead roach (uses dead sprite with green tint)
- **Roach Motel** = banking location using `roach-motel-sprite.jpeg`

---

## Prototype Status

### Implemented in `roach-prototype.html`
- [x] 2x2 room grid with edge-based navigation
- [x] Click to stomp with proper boot-sized hitbox
- [x] WASD roach control with drunk steering
- [x] 3-hit HP system with visual feedback
- [x] $ROACH balance with survival income (all roaches earn passively)
- [x] Rubber-band mechanic (rich = slow, configurable via game speed)
- [x] 90% death penalty
- [x] Live boot cursor (60% hover, tilts with movement direction)
- [x] Roaches flee from boots
- [x] House bot AI stompers (tilt in movement direction)
- [x] Room transition by crawling off edges
- [x] Heal button ($1 per HP)
- [x] Dev controls (spawn bots/roaches, motel controls, game speed)
- [x] Pixel aesthetic (no rounded corners)
- [x] Wealth attracts boots (dynamic house bot scaling based on room wealth)
- [x] Minimap wealth/danger indicators (yellow wealth bar, red bot count)
- [x] **Sprite-based graphics** using `game-sprite.png` atlas
- [x] **Roach rotation** - roaches face movement direction (smooth tilts)
- [x] **Roach scaling** - roaches grow 1x-3x based on wealth
- [x] **Sprite states** - idle, crawl, hit (red flash), and dead sprites
- [x] **Roach Motel banking** - random spawn, 5-second save timer, banked balance
- [x] **Roach respawning** - dead roaches respawn after 5-10 seconds
- [x] **Player indicator** - red arrow always visible above player roach
- [x] **Game speed controls** - adjustable 0.1x to 2.0x speed

### Not Yet Implemented
- [ ] Permanent upgrades (boot size, multi-stomp, rate-of-fire)
- [ ] Consumables (roach motel traps as area denial)
- [ ] Withdrawal timelock mechanic (withdraw banked $ROACH to real tokens)
- [ ] Vibecoins integration
- [ ] 10x10 room grid (currently 2x2)
- [ ] Multiplayer networking
- [ ] Sound design
- [ ] Mobile touch controls
- [ ] Leaderboards/seasons
- [ ] Roach minting with real crypto

---

## Open Questions / TBD

1. **Mint price scaling** - exact formula for 1c → $1 growth
2. **Withdrawal timelock duration** - minutes? hours? days?
3. **Survival income rate** - how much $ROACH per second/minute alive?
4. **Upgrade costs** - pricing for permanent upgrades
5. **Roach visual uniqueness** - procedurally generated? traits? NFT-style?
6. **Leaderboards/seasons** - any competitive layer?
7. **Sound design** - squelches, skittering, gross sound effects?

---

## Art Assets

### Sprite Files
- **`game-sprite.png`** - Main sprite atlas containing:
  - Row 1: Cockroach sprites (Idle, Crawl, Hit, Dead) - 128x128 each at source
  - Row 2: Empty padding
  - Row 3: Boot sprites (Hover, Stomp) - 256x256 each at source
- **`roach-motel-sprite.jpeg`** - Roach Motel building sprite (Happy Roach Motel)

### Sprite Usage
- Roaches rendered at 35x35px base size, scaled up to 3x with wealth
- Boots rendered at 100x110px (player) and 80x88px (house bots)
- Motel rendered at 240x240px
- All sprites use CSS `image-rendering: pixelated` for crisp pixel art look
- Color tinting via CSS filters (sepia, hue-rotate, saturate)

---

## Summary

$ROACH is a skill-based, real-time multiplayer stomping game with crypto mechanics. The rubber-band system (rich = slow) combined with the 90% death penalty and withdrawal timelock creates a game that rewards skill, active play, and reinvestment over passive extraction. The pixel aesthetic and 90s gross-out vibe keeps it fun and irreverent.
