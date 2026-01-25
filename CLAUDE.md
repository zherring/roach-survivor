# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

$ROACH is a skill-based multiplayer browser game where players mint roaches, stomp other roaches for $ROACH tokens, and survive as long as possible. The project currently consists of a single-file HTML prototype (`roach-prototype.html`) with plans for Vibecoins integration for tokenomics.

## Running the Prototype

Open `roach-prototype.html` directly in a browser - no build process or dependencies required.

## Architecture

### Current State: Single-File Prototype

The prototype is entirely contained in `roach-prototype.html`:
- **CSS** (lines 7-223): Pixel aesthetic styling, no rounded corners (90s Nickelodeon gross-out vibe)
- **HTML** (lines 225-273): Game UI including stats, minimap, canvas container, dev controls
- **JavaScript** (lines 275-1036): All game logic

### Key JavaScript Classes

- **`Roach`**: Core entity class handling movement, health, wealth-based speed (rubber-band mechanic), and room collision
- **`HouseBot`**: AI stomper that hunts roaches, preferring wealthy targets

### Game State Structure

```javascript
state = {
  balance,        // Player's $ROACH
  aliveTime,      // Survival timer
  kills,          // Kill counter
  currentRoom,    // "x,y" string
  rooms: {        // 2x2 grid (prototype), target is 10x10
    'x,y': { roaches: [], deaths, stompers, houseBots: [] }
  },
  playerRoach,    // Reference to player's Roach instance
  lastStomp,      // Cooldown tracking
}
```

### Core Mechanics (Implemented)

- **Stomping**: Click-based with boot-sized hitbox (30x40px), 200ms cooldown, scatter on miss
- **Movement**: WASD with "drunk steering" randomization
- **Health**: 3 HP, $1 per HP to heal
- **Death Penalty**: Lose 90% of balance to stomper
- **Rubber-band**: Higher balance = slower movement (wealth penalty capped at 1.5)
- **Room Navigation**: Must physically steer roach off screen edge (no teleporting)
- **Visible Boots**: Player boot at 40% opacity when hovering, roaches flee from both player and house bot boots
- **Wealth Attracts Boots**: House bots spawn dynamically based on room wealth (1 bot per $10 total wealth, max 5)

### Minimap Indicators

- **Wealth Bar**: Yellow bar at bottom of each room cell shows relative wealth (scales to $50 max)
- **Bot Indicator**: Red "!" marks show number of house bots in each room (up to 5)

### Visual Conventions

- Gray pixel: Regular roach (<$1)
- Yellow pixel: Rich roach ($10+)
- Cyan pixel: Player's roach
- Magenta: Player's roach when rich
- Green boot: Player's stomp cursor
- Red boot: House bot AI stomper

## Planned Features (Not Implemented)

See `PRD-ROACH-GAME.md` for full roadmap. Key items:
- Permanent upgrades (boot size, multi-stomp, rate-of-fire)
- Withdrawal timelock mechanic
- Vibecoins integration for tokenomics
- 10x10 room grid
- Multiplayer networking
- Mobile touch controls
