/**
 * Sprite Atlas Configuration for game-sprite.png
 *
 * Layout:
 * Row 1: Cockroach sprites (4 frames, uniform size)
 * Row 2: Empty padding
 * Row 3: Boot sprites (2 frames, larger than roaches)
 */

const SPRITE_ATLAS = {
  // Sheet dimensions
  sheet: {
    src: 'game-sprite.png',
    width: 512,
    height: 512
  },

  // Cockroach sprite dimensions (all roach frames share these)
  cockroach: {
    width: 128,
    height: 128
  },

  // Boot sprite dimensions (all boot frames share these)
  boot: {
    width: 256,
    height: 256
  },

  // Background-position coordinates for each sprite
  // Values are negative for CSS background-position usage
  positions: {
    // Row 1: Cockroach states (y = 0)
    cockroach_idle: { x: 0, y: 0 },
    crawl_01: { x: -128, y: 0 },
    hit: { x: -256, y: 0 },
    dead: { x: -384, y: 0 },

    // Row 3: Boot states (y = 256, after empty row)
    boot_hover: { x: 0, y: -256 },
    boot_stomp: { x: -256, y: -256 }
  }
};

/**
 * Helper function to get CSS background-position string
 * @param {string} spriteName - Name of the sprite (e.g., 'cockroach_idle', 'boot_hover')
 * @returns {string} CSS background-position value (e.g., '-128px 0px')
 */
function getSpritePosition(spriteName) {
  const pos = SPRITE_ATLAS.positions[spriteName];
  if (!pos) {
    console.warn(`Unknown sprite: ${spriteName}`);
    return '0px 0px';
  }
  return `${pos.x}px ${pos.y}px`;
}

/**
 * Helper function to get sprite dimensions
 * @param {string} spriteType - 'cockroach' or 'boot'
 * @returns {object} { width, height } in pixels
 */
function getSpriteDimensions(spriteType) {
  return SPRITE_ATLAS[spriteType] || { width: 0, height: 0 };
}

/**
 * Apply sprite to an element using CSS
 * @param {HTMLElement} element - Target DOM element
 * @param {string} spriteName - Name of the sprite
 * @param {string} spriteType - 'cockroach' or 'boot'
 */
function applySprite(element, spriteName, spriteType) {
  const pos = SPRITE_ATLAS.positions[spriteName];
  const dims = SPRITE_ATLAS[spriteType];

  if (!pos || !dims) {
    console.warn(`Invalid sprite: ${spriteName} (${spriteType})`);
    return;
  }

  element.style.backgroundImage = `url('${SPRITE_ATLAS.sheet.src}')`;
  element.style.backgroundPosition = `${pos.x}px ${pos.y}px`;
  element.style.backgroundRepeat = 'no-repeat';
  element.style.width = `${dims.width}px`;
  element.style.height = `${dims.height}px`;
}

/**
 * CSS class definitions for sprites (can be injected into document)
 */
const SPRITE_CSS = `
.sprite {
  background-image: url('game-sprite.png');
  background-repeat: no-repeat;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

/* Cockroach sprites - 128x128 */
.sprite-cockroach {
  width: 128px;
  height: 128px;
}

.sprite-cockroach-idle {
  background-position: 0px 0px;
}

.sprite-crawl-01 {
  background-position: -128px 0px;
}

.sprite-hit {
  background-position: -256px 0px;
}

.sprite-dead {
  background-position: -384px 0px;
}

/* Boot sprites - 256x256 */
.sprite-boot {
  width: 256px;
  height: 256px;
}

.sprite-boot-hover {
  background-position: 0px -256px;
}

.sprite-boot-stomp {
  background-position: -256px -256px;
}
`;

/**
 * Inject sprite CSS into document head
 */
function injectSpriteCSS() {
  const style = document.createElement('style');
  style.textContent = SPRITE_CSS;
  document.head.appendChild(style);
}

// Export for module usage (if needed)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SPRITE_ATLAS,
    SPRITE_CSS,
    getSpritePosition,
    getSpriteDimensions,
    applySprite,
    injectSpriteCSS
  };
}
