// Figma Desktop Bridge - MCP Plugin
// Bridges the Figma Plugin API to MCP clients via the plugin's UI iframe.
// Supports: Variables, Components, Styles, and more.
// Uses postMessage to communicate with ui.html (bypassing worker sandbox limitations),
// which then forwards messages to the MCP server over the WebSocket bridge.

// Plugin version — sent in FILE_INFO for server-side version compatibility checks.
// The server compares this against the version of the plugin files IT ships to
// detect stale cached plugins. Bumped by scripts/release.sh ONLY when plugin files
// change (see issue #62); server-only releases leave it alone, so it may lag
// package.json — that's intentional, not drift.
var PLUGIN_VERSION = '1.41.5'; // Last release in which plugin files changed.

console.log('🌉 [Desktop Bridge] Plugin loaded (v' + PLUGIN_VERSION + ')');

// Show minimal UI - compact status indicator
figma.showUI(__html__, { width: 240, height: 40, visible: true, themeColors: true });

// ============================================================================
// CONSOLE CAPTURE — Intercept console.* in the QuickJS sandbox and forward
// to ui.html via postMessage so the WebSocket bridge can relay them to the MCP
// server. This is the only console-capture path in local mode (no browser
// process is involved).
// ============================================================================
(function() {
  var levels = ['log', 'info', 'warn', 'error', 'debug'];
  var originals = {};
  for (var i = 0; i < levels.length; i++) {
    originals[levels[i]] = console[levels[i]];
  }

  function safeSerialize(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') return val;
    try {
      // Attempt JSON round-trip for objects/arrays (catches circular refs)
      return JSON.parse(JSON.stringify(val));
    } catch (e) {
      return String(val);
    }
  }

  for (var i = 0; i < levels.length; i++) {
    (function(level) {
      console[level] = function() {
        // Call the original so output still appears in Figma DevTools
        originals[level].apply(console, arguments);

        // Serialize arguments safely
        var args = [];
        for (var j = 0; j < arguments.length; j++) {
          args.push(safeSerialize(arguments[j]));
        }

        // Build message text from all arguments
        var messageParts = [];
        for (var j = 0; j < arguments.length; j++) {
          messageParts.push(typeof arguments[j] === 'string' ? arguments[j] : String(arguments[j]));
        }

        figma.ui.postMessage({
          type: 'CONSOLE_CAPTURE',
          level: level,
          message: messageParts.join(' '),
          args: args,
          timestamp: Date.now()
        });
      };
    })(levels[i]);
  }
})();

// Detect editor type (figma | figjam | slides | dev)
var __editorType = figma.editorType || 'figma';
console.log('🌉 [Desktop Bridge] Editor type:', __editorType);

// Shared sticky color map — used by CREATE_STICKY and CREATE_STICKIES
var __stickyColors = {
  'YELLOW': { r: 1, g: 0.85, b: 0.4 },
  'BLUE': { r: 0.53, g: 0.78, b: 1 },
  'GREEN': { r: 0.55, g: 0.87, b: 0.53 },
  'PINK': { r: 1, g: 0.6, b: 0.78 },
  'ORANGE': { r: 1, g: 0.71, b: 0.42 },
  'PURPLE': { r: 0.78, g: 0.65, b: 1 },
  'RED': { r: 1, g: 0.55, b: 0.55 },
  'LIGHT_GRAY': { r: 0.9, g: 0.9, b: 0.9 },
  'GRAY': { r: 0.7, g: 0.7, b: 0.7 }
};

// Immediately fetch and send variables data to UI (skip in FigJam — no variables API)
(async () => {
  if (__editorType === 'figjam' || __editorType === 'slides') {
    console.log('🌉 [Desktop Bridge] ' + __editorType + ' mode — skipping variables fetch');
    figma.ui.postMessage({
      type: 'VARIABLES_DATA',
      data: { success: true, timestamp: Date.now(), fileKey: figma.fileKey || null, variables: [], variableCollections: [], editorType: __editorType }
    });
    return;
  }
  try {
    console.log('🌉 [Desktop Bridge] Fetching variables...');

    // Get all local variables and collections
    const variables = await figma.variables.getLocalVariablesAsync();
    const collections = await figma.variables.getLocalVariableCollectionsAsync();

    console.log(`🌉 [Desktop Bridge] Found ${variables.length} variables in ${collections.length} collections`);

    // Format the data
    const variablesData = {
      success: true,
      timestamp: Date.now(),
      fileKey: figma.fileKey || null,
      variables: variables.map(v => ({
        id: v.id,
        name: v.name,
        key: v.key,
        resolvedType: v.resolvedType,
        valuesByMode: v.valuesByMode,
        variableCollectionId: v.variableCollectionId,
        scopes: v.scopes,
        codeSyntax: v.codeSyntax || {},
        description: v.description,
        hiddenFromPublishing: v.hiddenFromPublishing
      })),
      variableCollections: collections.map(c => ({
        id: c.id,
        name: c.name,
        key: c.key,
        modes: c.modes,
        defaultModeId: c.defaultModeId,
        variableIds: c.variableIds
      }))
    };

    // Send to UI via postMessage
    figma.ui.postMessage({
      type: 'VARIABLES_DATA',
      data: variablesData
    });

    console.log('🌉 [Desktop Bridge] Variables data sent to UI successfully');
    console.log('🌉 [Desktop Bridge] UI iframe now has variables data accessible via window.__figmaVariablesData');

  } catch (error) {
    console.error('🌉 [Desktop Bridge] Error fetching variables:', error);
    figma.ui.postMessage({
      type: 'ERROR',
      error: error.message || String(error)
    });
  }
})();

// Restore persisted cloud pairing config (stored via STORE_CLOUD_CONFIG) and
// push it to the UI so cloud users don't lose their pairing on plugin reopen.
// Fire-and-forget: never blocks the FILE_INFO/VARIABLES_DATA pushes above.
(function() {
  figma.clientStorage.getAsync('cloudConfig')
    .then(function(stored) {
      // Skip if nothing stored or the shape is unusable (e.g., cleared config)
      if (!stored || !stored.code) return;
      figma.ui.postMessage({ type: 'CLOUD_CONFIG_RESTORED', config: stored });
      console.log('🌉 [Desktop Bridge] Restored cloud config from clientStorage');
    })
    .catch(function(error) {
      // clientStorage can throw — non-critical, just log
      console.warn('🌉 [Desktop Bridge] Could not restore cloud config:', error && error.message ? error.message : String(error));
    });
})();

// Helper function to serialize a variable for response
function serializeVariable(v) {
  return {
    id: v.id,
    name: v.name,
    key: v.key,
    resolvedType: v.resolvedType,
    valuesByMode: v.valuesByMode,
    variableCollectionId: v.variableCollectionId,
    scopes: v.scopes,
    codeSyntax: v.codeSyntax || {},
    description: v.description,
    hiddenFromPublishing: v.hiddenFromPublishing
  };
}

// Helper function to serialize a collection for response
function serializeCollection(c) {
  return {
    id: c.id,
    name: c.name,
    key: c.key,
    modes: c.modes,
    defaultModeId: c.defaultModeId,
    variableIds: c.variableIds
  };
}

// Helper to extract a component's SLOT contract (Figma slots, GA June 2026).
// A slot is part of a component's public API: a named region that accepts freeform
// content, optionally constrained to preferred component values, with min/max limit
// violations surfaced on the slot node. Only non-variant COMPONENT and COMPONENT_SET
// nodes expose componentPropertyDefinitions — reading them on a variant throws, which
// is why older traversal code caught the error and skipped slot sublayers entirely.
function extractSlots(node) {
  function canReadDefs(n) {
    if (n.type === 'COMPONENT_SET') return true;
    if (n.type === 'COMPONENT') return !(n.parent && n.parent.type === 'COMPONENT_SET');
    return false;
  }
  if (!canReadDefs(node)) return [];
  var defs;
  try { defs = node.componentPropertyDefinitions; } catch (e) { return []; }
  if (!defs) return [];
  var byProp = {};
  for (var k in defs) {
    if (defs[k] && defs[k].type === 'SLOT') {
      byProp[k] = {
        propertyName: k,
        description: defs[k].description || null,
        preferredValues: (defs[k].preferredValues || []).slice(),
        slotNodeIds: [],
        slotNames: [],
        limitViolations: []
      };
    }
  }
  if (Object.keys(byProp).length === 0) return [];
  // Link each SLOT child node (which carries limitViolations) back to its property
  // via componentPropertyReferences.slotContentId. A COMPONENT_SET has one SLOT node
  // per variant pointing at the same property, so results are grouped by property.
  var slotNodes = [];
  try { slotNodes = node.findAllWithCriteria({ types: ['SLOT'] }); }
  catch (e) {
    try { slotNodes = node.findAll(function(n) { return n.type === 'SLOT'; }); } catch (e2) { slotNodes = []; }
  }
  for (var i = 0; i < slotNodes.length; i++) {
    var sn = slotNodes[i];
    var refs = sn.componentPropertyReferences || {};
    var pk = refs.slotContentId;
    var entry = (pk && byProp[pk]) ? byProp[pk] : null;
    if (!entry) {
      entry = byProp[pk || sn.id] = { propertyName: pk || null, description: null, preferredValues: [], slotNodeIds: [], slotNames: [], limitViolations: [] };
    }
    entry.slotNodeIds.push(sn.id);
    if (entry.slotNames.indexOf(sn.name) === -1) entry.slotNames.push(sn.name);
    var lv = sn.limitViolations || [];
    for (var j = 0; j < lv.length; j++) { if (entry.limitViolations.indexOf(lv[j]) === -1) entry.limitViolations.push(lv[j]); }
  }
  return Object.keys(byProp).map(function(key) {
    var e = byProp[key];
    return {
      name: e.slotNames[0] || e.propertyName,
      propertyName: e.propertyName,
      description: e.description,
      preferredValues: e.preferredValues,
      instanceCount: e.slotNodeIds.length,
      limitViolations: e.limitViolations
    };
  });
}

// Helper to convert hex color to Figma RGB (0-1 range)
function hexToFigmaRGB(hex) {
  // Remove # if present
  hex = hex.replace(/^#/, '');

  // Validate hex characters BEFORE parsing (prevents NaN values)
  if (!/^[0-9A-Fa-f]+$/.test(hex)) {
    throw new Error('Invalid hex color: "' + hex + '" contains non-hex characters. Use only 0-9 and A-F.');
  }

  // Parse hex values
  var r, g, b, a = 1;

  if (hex.length === 3) {
    // #RGB format
    r = parseInt(hex[0] + hex[0], 16) / 255;
    g = parseInt(hex[1] + hex[1], 16) / 255;
    b = parseInt(hex[2] + hex[2], 16) / 255;
  } else if (hex.length === 4) {
    // #RGBA format (CSS4 shorthand)
    r = parseInt(hex[0] + hex[0], 16) / 255;
    g = parseInt(hex[1] + hex[1], 16) / 255;
    b = parseInt(hex[2] + hex[2], 16) / 255;
    a = parseInt(hex[3] + hex[3], 16) / 255;
  } else if (hex.length === 6) {
    // #RRGGBB format
    r = parseInt(hex.substring(0, 2), 16) / 255;
    g = parseInt(hex.substring(2, 4), 16) / 255;
    b = parseInt(hex.substring(4, 6), 16) / 255;
  } else if (hex.length === 8) {
    // #RRGGBBAA format
    r = parseInt(hex.substring(0, 2), 16) / 255;
    g = parseInt(hex.substring(2, 4), 16) / 255;
    b = parseInt(hex.substring(4, 6), 16) / 255;
    a = parseInt(hex.substring(6, 8), 16) / 255;
  } else {
    throw new Error('Invalid hex color format: "' + hex + '". Expected 3, 4, 6, or 8 hex characters (e.g., #RGB, #RGBA, #RRGGBB, #RRGGBBAA).');
  }

  return { r: r, g: g, b: b, a: a };
}

// Build the ordered list of font-style names to try for a requested style.
// Figma style names are exact and space-sensitive: Inter's semibold is
// "Semi Bold" (with a space), not "SemiBold". We try the value as-is first
// (some families legitimately use no-space names), then a space-normalized
// variant, then a space-collapsed variant.
function normalizeFontStyleVariants(style) {
  var variants = [];
  function push(v) { if (v && variants.indexOf(v) === -1) variants.push(v); }
  push(style);
  push(String(style).replace(/([a-z])([A-Z])/g, '$1 $2')); // "SemiBold" -> "Semi Bold"
  push(String(style).replace(/\s+/g, ''));                   // "Semi Bold" -> "SemiBold"
  return variants;
}

// Load a font, tolerating common style-name variants. A wrong style name
// otherwise fails (often silently), leaving wrong typography with no error.
// Falls back to "Regular" so a bad weight degrades gracefully, and throws a
// clear, actionable error only if nothing loads.
async function loadFontWithFallback(family, requestedStyle) {
  var style = requestedStyle || 'Regular';
  var attempts = normalizeFontStyleVariants(style);
  for (var i = 0; i < attempts.length; i++) {
    try {
      var fontName = { family: family, style: attempts[i] };
      await figma.loadFontAsync(fontName);
      return fontName;
    } catch (e) { /* try next variant */ }
  }
  try {
    var fallback = { family: family, style: 'Regular' };
    await figma.loadFontAsync(fallback);
    return fallback;
  } catch (e) {
    throw new Error('Could not load font "' + family + ' ' + style + '". Tried: ' +
      attempts.join(', ') + ', Regular. Check the family name and that the weight exists ' +
      '(Figma styles are space-sensitive, e.g. "Semi Bold" not "SemiBold").');
  }
}

// Pre-load every font used by a node's text descendants in ONE pass. Mutating
// a text node in dynamic-page mode throws unless its font is loaded first;
// loading per-node in a loop is also what causes timeouts at scale.
async function loadFontsForNode(node) {
  if (!node) return;
  var textNodes = [];
  if (node.type === 'TEXT') {
    textNodes = [node];
  } else if (typeof node.findAllWithCriteria === 'function') {
    try { textNodes = node.findAllWithCriteria({ types: ['TEXT'] }); }
    catch (e) { textNodes = []; }
  } else if (typeof node.findAll === 'function') {
    textNodes = node.findAll(function(n) { return n.type === 'TEXT'; });
  }
  var seen = {};
  var fonts = [];
  for (var i = 0; i < textNodes.length; i++) {
    var tn = textNodes[i];
    var names = [];
    if (tn.fontName === figma.mixed) {
      try { names = tn.getRangeAllFontNames(0, tn.characters.length); }
      catch (e) { names = []; }
    } else if (tn.fontName) {
      names = [tn.fontName];
    }
    for (var j = 0; j < names.length; j++) {
      var key = names[j].family + '||' + names[j].style;
      if (!seen[key]) { seen[key] = true; fonts.push(names[j]); }
    }
  }
  for (var k = 0; k < fonts.length; k++) {
    try { await figma.loadFontAsync(fonts[k]); } catch (e) { /* skip unavailable */ }
  }
}

// Resolve a caller-supplied component property name against the instance's
// actual property keys. TEXT/BOOLEAN/INSTANCE_SWAP property names carry a
// #nodeId suffix (e.g. "title#2605:17"), so a bare "title" from the caller
// must be mapped to the suffixed key. Resolution tiers:
//   1. Exact match (covers VARIANT props and fully-suffixed names)
//   2. Base name before '#' matches exactly
//   3. Case-insensitive base-name match
// Returns the resolved key, or null if nothing matches.
function resolvePropertyName(currentProps, name) {
  if (!currentProps || !name) return null;
  if (currentProps[name] !== undefined) return name;
  var existingProp;
  for (existingProp in currentProps) {
    if (currentProps.hasOwnProperty(existingProp) && existingProp.split('#')[0] === name) {
      return existingProp;
    }
  }
  var lowerName = String(name).toLowerCase();
  for (existingProp in currentProps) {
    if (currentProps.hasOwnProperty(existingProp) && existingProp.split('#')[0].toLowerCase() === lowerName) {
      return existingProp;
    }
  }
  return null;
}

// ============================================================================
// Slot helpers — Figma Slots open beta (SlotNode API)
// ============================================================================

function serializeSlotsFromNode(rootNode) {
  var slots = [];
  if (!rootNode || typeof rootNode.findAllWithCriteria !== 'function') {
    return slots;
  }

  var slotNodes = rootNode.findAllWithCriteria({ types: ['SLOT'] });
  for (var si = 0; si < slotNodes.length; si++) {
    var slot = slotNodes[si];
    var slotInfo = {
      id: slot.id,
      name: slot.name,
      type: 'SLOT',
      width: slot.width,
      height: slot.height,
      layoutMode: slot.layoutMode || 'NONE',
      propertyKey: null,
      children: []
    };

    try {
      if (slot.componentPropertyReferences && slot.componentPropertyReferences.slotContentId) {
        slotInfo.propertyKey = slot.componentPropertyReferences.slotContentId;
      }
    } catch (e) { /* ignore */ }

    try {
      for (var ci = 0; ci < slot.children.length; ci++) {
        var ch = slot.children[ci];
        slotInfo.children.push({ id: ch.id, name: ch.name, type: ch.type });
      }
    } catch (e) { /* slot sublayer — skip inaccessible children */ }

    slots.push(slotInfo);
  }

  return slots;
}

async function resolveSlotNode(params) {
  if (params.slotId) {
    var slotById = await figma.getNodeByIdAsync(params.slotId);
    if (!slotById) {
      throw new Error('Slot node not found: ' + params.slotId);
    }
    if (slotById.type !== 'SLOT') {
      throw new Error('Node is not a SLOT. Got: ' + slotById.type);
    }
    return slotById;
  }

  if (params.instanceId && params.slotName) {
    var instance = await figma.getNodeByIdAsync(params.instanceId);
    if (!instance) {
      throw new Error('Instance node not found: ' + params.instanceId);
    }
    if (instance.type !== 'INSTANCE') {
      throw new Error('Node must be an INSTANCE when using instanceId + slotName. Got: ' + instance.type);
    }
    if (typeof instance.findAllWithCriteria !== 'function') {
      throw new Error('Instance does not support slot lookup');
    }
    var allSlots = instance.findAllWithCriteria({ types: ['SLOT'] });
    var matches = allSlots.filter(function(n) {
      return n.name === params.slotName;
    });
    if (matches.length === 0) {
      var available = allSlots.map(function(n) { return n.name; });
      throw new Error('Slot "' + params.slotName + '" not found on instance. Available slots: ' + (available.length ? available.join(', ') : '(none)'));
    }
    // findAllWithCriteria is deep — a nested instance can carry an identically
    // named slot. Prefer the instance's OWN slot (direct child) over nested ones.
    var direct = matches.filter(function(n) { return n.parent === instance; });
    return (direct.length ? direct : matches)[0];
  }

  throw new Error('Provide slotId OR (instanceId + slotName)');
}

// ============================================================================
// GHOST CURSORS (optional, toggled from the agent panel)
// One locked container frame per page holds one small cursor per agent. All
// ghost nodes are tagged with plugin data and ignored by the documentchange
// handler. They are real nodes (visible to collaborators, exports and undo),
// so they are removed when an agent goes idle, when toggled off, and on close.
// ============================================================================
var GHOST_TAG = 'agentGhostCursor';
var GHOST_CONTAINER_NAME = '⟡ Agent cursors (temporary)';
var ghostIds = {};          // every ghost node id ever created (ignored by documentchange)
var ghostEnabled = true;
var ghosts = {};            // agentKey -> { node, tx, ty, timer, page }
var ghostFontReady = false;
var ghostFont = { family: 'Inter', style: 'Medium' };

function ghostMark(node) {
  ghostIds[node.id] = true;
  node.setPluginData(GHOST_TAG, '1');
}

async function ghostContainerFor(page) {
  for (var i = 0; i < page.children.length; i++) {
    var c = page.children[i];
    if (c.type === 'FRAME' && c.getPluginData(GHOST_TAG) === 'container') { ghostIds[c.id] = true; return c; }
  }
  var f = figma.createFrame();
  f.name = GHOST_CONTAINER_NAME;
  f.resize(1, 1); f.x = 0; f.y = 0;
  f.fills = []; f.clipsContent = false;
  f.setPluginData(GHOST_TAG, 'container'); ghostIds[f.id] = true;
  page.appendChild(f);
  f.locked = true;
  return f;
}

function ghostScaleNow() {
  return Math.max(0.05, Math.min(40, 1.15 / (figma.viewport.zoom || 1)));
}

// Built at an absolute scale (no rescale() drift): all sizes are multiplied by s.
async function ghostBuild(container, name, color, s) {
  if (!ghostFontReady) {
    // Inter has no Bengali glyphs; prefer Noto Sans Bengali, fall back to Inter.
    var candidates = [{ family: 'Noto Sans Bengali', style: 'Medium' }, { family: 'Noto Sans Bengali', style: 'Regular' }, { family: 'Inter', style: 'Medium' }];
    for (var ci = 0; ci < candidates.length && !ghostFontReady; ci++) {
      try { await figma.loadFontAsync(candidates[ci]); ghostFont = candidates[ci]; ghostFontReady = true; } catch (e) {}
    }
  }
  var rgb = { r: parseInt(color.slice(1, 3), 16) / 255, g: parseInt(color.slice(3, 5), 16) / 255, b: parseInt(color.slice(5, 7), 16) / 255 };
  var cur = figma.createFrame();
  cur.name = name; cur.fills = []; cur.clipsContent = false; cur.resize(12 * s, 19 * s);
  container.appendChild(cur); ghostMark(cur);
  var arrow = figma.createVector();
  cur.appendChild(arrow); ghostMark(arrow);
  var pts = [[0, 0], [0, 16], [4.5, 12], [8, 19], [10.5, 18], [7, 11.5], [12, 11.5]];
  await arrow.setVectorNetworkAsync({
    vertices: pts.map(function(p) { return { x: p[0] * s, y: p[1] * s }; }),
    segments: [0, 1, 2, 3, 4, 5, 6].map(function(i) { return { start: i, end: (i + 1) % 7 }; }),
    regions: [{ windingRule: 'NONZERO', loops: [[0, 1, 2, 3, 4, 5, 6]] }]
  });
  arrow.fills = [{ type: 'SOLID', color: rgb }];
  arrow.strokes = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; arrow.strokeWeight = Math.max(0.1, s);
  var label = figma.createFrame();
  label.layoutMode = 'HORIZONTAL'; label.primaryAxisSizingMode = 'AUTO'; label.counterAxisSizingMode = 'AUTO';
  label.paddingLeft = label.paddingRight = 6 * s; label.paddingTop = label.paddingBottom = 2 * s;
  label.cornerRadius = 4 * s; label.fills = [{ type: 'SOLID', color: rgb }];
  var t = figma.createText(); t.fontName = ghostFont;
  t.characters = name; t.fontSize = Math.max(1, 11 * s); t.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  label.appendChild(t); cur.appendChild(label);
  label.x = 12 * s; label.y = 16 * s;
  ghostMark(label); ghostMark(t);
  return cur;
}

// Keep cursors a constant on-screen size: rebuild at the new scale when zoom changed.
async function ghostFit(key) {
  var g = ghosts[key];
  if (!g || g.fitting) return;
  var want = ghostScaleNow();
  if (Math.abs(want / g.scale - 1) <= 0.08) return;
  g.fitting = true;
  try {
    var container = g.node.parent, x = g.node.x, y = g.node.y;
    var old = g.node;
    var fresh = await ghostBuild(container, g.name, g.color, want);
    if (ghosts[key] !== g) {
      // The agent's cursor was removed while we were rebuilding it: discard the new one too
      try { fresh.remove(); } catch (e) {}
      ghostCleanContainer(container);
      return;
    }
    fresh.x = x; fresh.y = y;
    g.node = fresh; g.scale = want;
    try { old.remove(); } catch (e) {}
  } finally { g.fitting = false; }
}

// Zoom can change while agents are idle or between updates, so refit all cursors periodically.
setInterval(function() {
  if (!ghostEnabled) return;
  Object.keys(ghosts).forEach(function(k) { ghostFit(k).catch(function() {}); });
}, 300);

function ghostCleanContainer(container) {
  try { if (container && !container.removed && container.children.length === 0 && container.getPluginData(GHOST_TAG) === 'container') container.remove(); } catch (e) {}
}

function ghostRemove(key) {
  var g = ghosts[key];
  if (!g) return;
  if (g.timer) clearInterval(g.timer);
  var container = null;
  try { container = g.node.parent; if (!g.node.removed) g.node.remove(); } catch (e) {}
  delete ghosts[key];
  // Leave nothing behind: drop the container frame once its last cursor is gone
  ghostCleanContainer(container);
}

function ghostRemoveAll() {
  Object.keys(ghosts).forEach(ghostRemove);
  // Also sweep empty containers left on the current page (e.g. after a crash)
  try {
    figma.currentPage.children.forEach(function(c) {
      if (c.type === 'FRAME' && c.getPluginData(GHOST_TAG) === 'container') { ghostIds[c.id] = true; c.remove(); }
    });
  } catch (e) {}
}

// FOLLOW: glide the viewport to the followed agent's node (centre + zoom), easing each tick.
var followKey = null, followTarget = null, followTimer = null;
function followTo(box) {
  var b = figma.viewport.bounds, z = figma.viewport.zoom;
  var vw = b.width * z, vh = b.height * z;                       // viewport size in screen pixels (constant)
  var rw = Math.max(box.width * 2.2, 900), rh = Math.max(box.height * 2.2, 600);
  followTarget = {
    cx: box.x + box.width / 2, cy: box.y + box.height / 2,
    zoom: Math.max(0.01, Math.min(8, Math.min(vw / rw, vh / rh)))
  };
  if (followTimer) return;
  followTimer = setInterval(function() {
    if (!followTarget) { clearInterval(followTimer); followTimer = null; return; }
    var c = figma.viewport.center, zz = figma.viewport.zoom, t = followTarget;
    var nz = zz * Math.pow(t.zoom / zz, 0.25);
    var dx = t.cx - c.x, dy = t.cy - c.y;
    figma.viewport.zoom = nz;
    figma.viewport.center = { x: c.x + dx * 0.25, y: c.y + dy * 0.25 };
    if (Math.abs(dx) * nz < 1 && Math.abs(dy) * nz < 1 && Math.abs(t.zoom / zz - 1) < 0.01) { clearInterval(followTimer); followTimer = null; }
  }, 60);
}
function followStop() {
  followKey = null; followTarget = null;
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
}

var ghostQueue = {};
function ghostEnqueue(key, fn) {
  var p = (ghostQueue[key] || Promise.resolve()).then(fn).catch(function(e) { console.warn('🌉 [Desktop Bridge] ghost op failed:', e && e.message); });
  ghostQueue[key] = p;
  return p;
}

async function ghostUpdate(a) {
  if (!a) return;
  var page = figma.currentPage, tx, ty;
  var target = a.nodeId ? await figma.getNodeByIdAsync(a.nodeId) : null;
  if (target && !target.removed && target.absoluteBoundingBox) {
    page = target; while (page && page.type !== 'PAGE') page = page.parent;
    if (!page) return;
    var box = target.absoluteBoundingBox;
    tx = box.x + box.width; ty = box.y;
    if (followKey && a.key === followKey) {
      if (page !== figma.currentPage) { try { await figma.setCurrentPageAsync(page); } catch (e) {} }
      followTo(box);
    }
  } else {
    // No node known yet (command just arrived): show the agent at the viewport centre right away
    var vc = figma.viewport.center;
    tx = vc.x; ty = vc.y;
    if (ghosts[a.key]) return; // keep existing position until a real node is known
  }
  if (!ghostEnabled || a.show === false) return;
  var g = ghosts[a.key];
  if (g && g.page !== page.id) { ghostRemove(a.key); g = null; }
  if (!g) {
    var container = await ghostContainerFor(page);
    var sc = ghostScaleNow();
    var node = await ghostBuild(container, a.name, a.color, sc);
    if (!ghostEnabled) { try { node.remove(); } catch (e) {} return; }
    node.x = tx; node.y = ty;
    g = ghosts[a.key] = { node: node, tx: tx, ty: ty, timer: null, page: page.id, scale: sc, name: a.name, color: a.color, fitting: false };
    return;
  }
  g.tx = tx; g.ty = ty;
  await ghostFit(a.key);
  if (!g.timer) {
    // Ease toward the target ~12 times a second; stop when arrived
    g.timer = setInterval(function() {
      if (g.node.removed) { ghostRemove(a.key); return; }
      var dx = g.tx - g.node.x, dy = g.ty - g.node.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) { g.node.x = g.tx; g.node.y = g.ty; clearInterval(g.timer); g.timer = null; return; }
      g.node.x += dx * 0.35; g.node.y += dy * 0.35;
    }, 80);
  }
}

figma.on('close', function() { followStop(); ghostRemoveAll(); });
// Remove leftovers from a previous crashed session (current page)
try { ghostRemoveAll(); } catch (e) {}

// Listen for requests from UI (e.g., component data requests, write operations)
figma.ui.onmessage = async (msg) => {

  // Custom fiGapture: build screenshots + design system from captures
  if (msg.type === 'FIGAPTURE_BUILD') { await fiGaptureBuild(msg); return; }
  if (msg.type === 'FIGAPTURE_PREFS_GET') {
    var fsPrefs = null;
    try { fsPrefs = await figma.clientStorage.getAsync('fiGaptureChoices'); } catch (e) { fsPrefs = null; }
    figma.ui.postMessage({ type: 'FIGAPTURE_PREFS', value: fsPrefs || null });
    return;
  }
  if (msg.type === 'FIGAPTURE_PREFS_SET') { try { await figma.clientStorage.setAsync('fiGaptureChoices', msg.value); } catch (e) { /* storage unavailable: not critical */ } return; }
  if (typeof msg.type === 'string' && msg.type.indexOf('FIGAPTURE_LAYERS_') === 0) { await fiGaptureLayers(msg); return; }
  if (typeof msg.type === 'string' && msg.type.indexOf('TR_') === 0) { await trHandle(msg); return; }

  // REPORT_RESOLVE - turn node ids into readable names for the agent report (read-only)
  if (msg.type === 'REPORT_RESOLVE') {
    var rnames = {};
    try {
      var rids = (msg.ids || []).slice(0, 150);
      for (var ri = 0; ri < rids.length; ri++) {
        try {
          var rn = await figma.getNodeByIdAsync(rids[ri]);
          rnames[rids[ri]] = rn ? (rn.name + ' (' + rn.type.toLowerCase() + ')') : rids[ri] + ' (deleted)';
        } catch (e) { rnames[rids[ri]] = rids[ri]; }
      }
    } catch (e) {}
    figma.ui.postMessage({ type: 'REPORT_NAMES', names: rnames, fileName: figma.root.name });
    return;
  }

  // HISTORY_GET / HISTORY_SAVE - persist the agent history list across plugin sessions
  if (msg.type === 'HISTORY_GET') {
    try {
      var hist = await figma.clientStorage.getAsync('agentHistory');       // legacy per-agent entries
      var savedTasks = await figma.clientStorage.getAsync('agentTasks');
      figma.ui.postMessage({ type: 'HISTORY_DATA', entries: Array.isArray(hist) ? hist : [], tasks: Array.isArray(savedTasks) ? savedTasks : [] });
    } catch (e) { figma.ui.postMessage({ type: 'HISTORY_DATA', entries: [], tasks: [] }); }
    return;
  }
  if (msg.type === 'HISTORY_SAVE') {
    try {
      if (Array.isArray(msg.tasks)) await figma.clientStorage.setAsync('agentTasks', msg.tasks.slice(0, 30));
      else if (Array.isArray(msg.entries)) await figma.clientStorage.setAsync('agentHistory', msg.entries.slice(0, 50));
    } catch (e) {}
    return;
  }

  // FOLLOW_AGENT - viewport follows one agent (null stops following)
  if (msg.type === 'FOLLOW_AGENT') {
    if (msg.key) { followKey = msg.key; } else { followStop(); }
    return;
  }

  // GHOST_CURSORS - toggle / update / remove ghost cursors (agent panel)
  if (msg.type === 'GHOST_CURSORS') {
    try {
      if (msg.action === 'enable') { ghostEnabled = true; }
      else if (msg.action === 'disable') { ghostEnabled = false; ghostRemoveAll(); }
      else if (msg.action === 'update') { await ghostEnqueue(msg.agent.key, function() { return ghostUpdate(msg.agent); }); }
      else if (msg.action === 'remove') { await ghostEnqueue(msg.key, function() { ghostRemove(msg.key); }); }
    } catch (e) {
      console.warn('🌉 [Desktop Bridge] GHOST_CURSORS failed:', e && e.message);
    }
    return;
  }

  // FOCUS_NODES - agent panel: jump the viewport to an agent's last-touched nodes (read-only)
  if (msg.type === 'FOCUS_NODES') {
    try {
      var focusNodes = [];
      for (var fi = 0; fi < msg.nodeIds.length; fi++) {
        var fn = await figma.getNodeByIdAsync(msg.nodeIds[fi]);
        if (fn && fn.type !== 'DOCUMENT' && fn.type !== 'PAGE') focusNodes.push(fn);
      }
      if (focusNodes.length) {
        var fp = focusNodes[0];
        while (fp && fp.type !== 'PAGE') fp = fp.parent;
        if (fp && fp !== figma.currentPage) await figma.setCurrentPageAsync(fp);
        figma.viewport.scrollAndZoomIntoView(focusNodes);
      }
    } catch (e) {
      console.warn('🌉 [Desktop Bridge] FOCUS_NODES failed:', e && e.message);
    }
    return;
  }

  // ============================================================================
  // EXECUTE_CODE - Arbitrary code execution (Power Tool)
  // ============================================================================
  if (msg.type === 'EXECUTE_CODE') {
    try {
      console.log('🌉 [Desktop Bridge] Executing code, length:', msg.code.length);

      // Use eval with async IIFE wrapper instead of AsyncFunction constructor
      // AsyncFunction is restricted in Figma's plugin sandbox, but eval works
      // See: https://developers.figma.com/docs/plugins/resource-links

      // Wrap user code in an async IIFE that returns a Promise
      // This allows async/await in user code while using eval
      var wrappedCode = "(async function() {\n" + msg.code + "\n})()";

      console.log('🌉 [Desktop Bridge] Wrapped code for eval');

      // Execute with timeout
      var timeoutMs = msg.timeout || 5000;
      var timeoutPromise = new Promise(function(_, reject) {
        setTimeout(function() {
          reject(new Error('Execution timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
      });

      var codePromise;
      try {
        // eval returns the Promise from the async IIFE
        codePromise = eval(wrappedCode);
      } catch (syntaxError) {
        // Log the actual syntax error message
        var syntaxErrorMsg = syntaxError && syntaxError.message ? syntaxError.message : String(syntaxError);
        console.error('🌉 [Desktop Bridge] Syntax error in code:', syntaxErrorMsg);
        figma.ui.postMessage({
          type: 'EXECUTE_CODE_RESULT',
          requestId: msg.requestId,
          success: false,
          error: 'Syntax error: ' + syntaxErrorMsg
        });
        return;
      }

      var result = await Promise.race([
        codePromise,
        timeoutPromise
      ]);

      console.log('🌉 [Desktop Bridge] Code executed successfully, result type:', typeof result);

      // Analyze result for potential silent failures
      var resultAnalysis = {
        type: typeof result,
        isNull: result === null,
        isUndefined: result === undefined,
        isEmpty: false,
        warning: null
      };

      // Check for empty results that might indicate a failed search/operation
      if (Array.isArray(result)) {
        resultAnalysis.isEmpty = result.length === 0;
        if (resultAnalysis.isEmpty) {
          resultAnalysis.warning = 'Code returned an empty array. If you were searching for nodes, none were found.';
        }
      } else if (result !== null && typeof result === 'object') {
        var keys = Object.keys(result);
        resultAnalysis.isEmpty = keys.length === 0;
        if (resultAnalysis.isEmpty) {
          resultAnalysis.warning = 'Code returned an empty object. The operation may not have found what it was looking for.';
        }
        // Check for common "found nothing" patterns
        if (result.length === 0 || result.count === 0 || result.foundCount === 0 || (result.nodes && result.nodes.length === 0)) {
          resultAnalysis.warning = 'Code returned a result indicating nothing was found (count/length is 0).';
        }
      } else if (result === null) {
        resultAnalysis.warning = 'Code returned null. The requested node or resource may not exist.';
      } else if (result === undefined) {
        resultAnalysis.warning = 'Code returned undefined. Make sure your code has a return statement.';
      }

      if (resultAnalysis.warning) {
        console.warn('🌉 [Desktop Bridge] ⚠️ Result warning:', resultAnalysis.warning);
      }

      figma.ui.postMessage({
        type: 'EXECUTE_CODE_RESULT',
        requestId: msg.requestId,
        success: true,
        result: result,
        resultAnalysis: resultAnalysis,
        // Include file context so users know which file this executed against
        fileContext: {
          fileName: figma.root.name,
          fileKey: figma.fileKey || null
        }
      });

    } catch (error) {
      // Extract error message explicitly - don't rely on console.error serialization
      var errorName = error && error.name ? error.name : 'Error';
      var errorMsg = error && error.message ? error.message : String(error);
      var errorStack = error && error.stack ? error.stack : '';

      // Log error details as strings so they survive intact through the WebSocket bridge into figma_get_console_logs
      console.error('🌉 [Desktop Bridge] Code execution error: [' + errorName + '] ' + errorMsg);
      if (errorStack) {
        console.error('🌉 [Desktop Bridge] Stack:', errorStack);
      }

      figma.ui.postMessage({
        type: 'EXECUTE_CODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorName + ': ' + errorMsg
      });
    }
  }

  // ============================================================================
  // UPDATE_VARIABLE - Update a variable's value in a specific mode
  // ============================================================================
  else if (msg.type === 'UPDATE_VARIABLE') {
    try {
      console.log('🌉 [Desktop Bridge] Updating variable:', msg.variableId);

      var variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        throw new Error('Variable not found: ' + msg.variableId);
      }

      // Convert value based on variable type
      var value = msg.value;

      // Check if value is a variable alias (string starting with "VariableID:")
      if (typeof value === 'string' && value.startsWith('VariableID:')) {
        // Convert to VARIABLE_ALIAS format
        value = {
          type: 'VARIABLE_ALIAS',
          id: value
        };
        console.log('🌉 [Desktop Bridge] Converting to variable alias:', value.id);
      } else if (variable.resolvedType === 'COLOR' && typeof value === 'string') {
        // Convert hex string to Figma color
        value = hexToFigmaRGB(value);
      }

      // Set the value for the specified mode
      variable.setValueForMode(msg.modeId, value);

      console.log('🌉 [Desktop Bridge] Variable updated successfully');

      figma.ui.postMessage({
        type: 'UPDATE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializeVariable(variable)
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Update variable error:', error);
      figma.ui.postMessage({
        type: 'UPDATE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // CREATE_VARIABLE - Create a new variable in a collection
  // ============================================================================
  else if (msg.type === 'CREATE_VARIABLE') {
    try {
      console.log('🌉 [Desktop Bridge] Creating variable:', msg.name);

      // Get the collection
      var collection = await figma.variables.getVariableCollectionByIdAsync(msg.collectionId);
      if (!collection) {
        throw new Error('Collection not found: ' + msg.collectionId);
      }

      // Create the variable
      var variable = figma.variables.createVariable(msg.name, collection, msg.resolvedType);

      // Set initial values if provided
      if (msg.valuesByMode) {
        for (var modeId in msg.valuesByMode) {
          var value = msg.valuesByMode[modeId];
          // Convert hex colors
          if (msg.resolvedType === 'COLOR' && typeof value === 'string') {
            value = hexToFigmaRGB(value);
          }
          variable.setValueForMode(modeId, value);
        }
      }

      // Set description if provided
      if (msg.description) {
        variable.description = msg.description;
      }

      // Set scopes if provided
      if (msg.scopes) {
        variable.scopes = msg.scopes;
      }

      console.log('🌉 [Desktop Bridge] Variable created:', variable.id);

      figma.ui.postMessage({
        type: 'CREATE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializeVariable(variable)
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create variable error:', error);
      figma.ui.postMessage({
        type: 'CREATE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // CREATE_VARIABLE_COLLECTION - Create a new variable collection
  // ============================================================================
  else if (msg.type === 'CREATE_VARIABLE_COLLECTION') {
    try {
      console.log('🌉 [Desktop Bridge] Creating collection:', msg.name);

      // Create the collection
      var collection = figma.variables.createVariableCollection(msg.name);

      // Rename the default mode if a name is provided
      if (msg.initialModeName && collection.modes.length > 0) {
        collection.renameMode(collection.modes[0].modeId, msg.initialModeName);
      }

      // Add additional modes if provided
      if (msg.additionalModes && msg.additionalModes.length > 0) {
        for (var i = 0; i < msg.additionalModes.length; i++) {
          collection.addMode(msg.additionalModes[i]);
        }
      }

      console.log('🌉 [Desktop Bridge] Collection created:', collection.id);

      figma.ui.postMessage({
        type: 'CREATE_VARIABLE_COLLECTION_RESULT',
        requestId: msg.requestId,
        success: true,
        collection: serializeCollection(collection)
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create collection error:', error);
      figma.ui.postMessage({
        type: 'CREATE_VARIABLE_COLLECTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // DELETE_VARIABLE - Delete a variable
  // ============================================================================
  else if (msg.type === 'DELETE_VARIABLE') {
    try {
      console.log('🌉 [Desktop Bridge] Deleting variable:', msg.variableId);

      var variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        throw new Error('Variable not found: ' + msg.variableId);
      }

      var deletedInfo = {
        id: variable.id,
        name: variable.name
      };

      variable.remove();

      console.log('🌉 [Desktop Bridge] Variable deleted');

      figma.ui.postMessage({
        type: 'DELETE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        deleted: deletedInfo
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Delete variable error:', error);
      figma.ui.postMessage({
        type: 'DELETE_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // DELETE_VARIABLE_COLLECTION - Delete a variable collection
  // ============================================================================
  else if (msg.type === 'DELETE_VARIABLE_COLLECTION') {
    try {
      console.log('🌉 [Desktop Bridge] Deleting collection:', msg.collectionId);

      var collection = await figma.variables.getVariableCollectionByIdAsync(msg.collectionId);
      if (!collection) {
        throw new Error('Collection not found: ' + msg.collectionId);
      }

      var deletedInfo = {
        id: collection.id,
        name: collection.name,
        variableCount: collection.variableIds.length
      };

      collection.remove();

      console.log('🌉 [Desktop Bridge] Collection deleted');

      figma.ui.postMessage({
        type: 'DELETE_VARIABLE_COLLECTION_RESULT',
        requestId: msg.requestId,
        success: true,
        deleted: deletedInfo
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Delete collection error:', error);
      figma.ui.postMessage({
        type: 'DELETE_VARIABLE_COLLECTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // RENAME_VARIABLE - Rename a variable
  // ============================================================================
  else if (msg.type === 'RENAME_VARIABLE') {
    try {
      console.log('🌉 [Desktop Bridge] Renaming variable:', msg.variableId, 'to', msg.newName);

      var variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        throw new Error('Variable not found: ' + msg.variableId);
      }

      var oldName = variable.name;
      variable.name = msg.newName;

      console.log('🌉 [Desktop Bridge] Variable renamed from "' + oldName + '" to "' + msg.newName + '"');

      var serializedVar = serializeVariable(variable);
      serializedVar.oldName = oldName;
      figma.ui.postMessage({
        type: 'RENAME_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializedVar,
        oldName: oldName
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Rename variable error:', error);
      figma.ui.postMessage({
        type: 'RENAME_VARIABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // SET_VARIABLE_DESCRIPTION - Set description on a variable
  // ============================================================================
  else if (msg.type === 'SET_VARIABLE_DESCRIPTION') {
    try {
      console.log('🌉 [Desktop Bridge] Setting description on variable:', msg.variableId);

      var variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        throw new Error('Variable not found: ' + msg.variableId);
      }

      variable.description = msg.description || '';

      console.log('🌉 [Desktop Bridge] Variable description set successfully');

      figma.ui.postMessage({
        type: 'SET_VARIABLE_DESCRIPTION_RESULT',
        requestId: msg.requestId,
        success: true,
        variable: serializeVariable(variable)
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set variable description error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_VARIABLE_DESCRIPTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // ADD_MODE - Add a mode to a variable collection
  // ============================================================================
  else if (msg.type === 'ADD_MODE') {
    try {
      console.log('🌉 [Desktop Bridge] Adding mode to collection:', msg.collectionId);

      var collection = await figma.variables.getVariableCollectionByIdAsync(msg.collectionId);
      if (!collection) {
        throw new Error('Collection not found: ' + msg.collectionId);
      }

      // Add the mode (returns the new mode ID)
      var newModeId = collection.addMode(msg.modeName);

      console.log('🌉 [Desktop Bridge] Mode "' + msg.modeName + '" added with ID:', newModeId);

      figma.ui.postMessage({
        type: 'ADD_MODE_RESULT',
        requestId: msg.requestId,
        success: true,
        collection: serializeCollection(collection),
        newMode: {
          modeId: newModeId,
          name: msg.modeName
        }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Add mode error:', error);
      figma.ui.postMessage({
        type: 'ADD_MODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // RENAME_MODE - Rename a mode in a variable collection
  // ============================================================================
  else if (msg.type === 'RENAME_MODE') {
    try {
      console.log('🌉 [Desktop Bridge] Renaming mode:', msg.modeId, 'in collection:', msg.collectionId);

      var collection = await figma.variables.getVariableCollectionByIdAsync(msg.collectionId);
      if (!collection) {
        throw new Error('Collection not found: ' + msg.collectionId);
      }

      // Find the current mode name
      var currentMode = collection.modes.find(function(m) { return m.modeId === msg.modeId; });
      if (!currentMode) {
        throw new Error('Mode not found: ' + msg.modeId);
      }

      var oldName = currentMode.name;
      collection.renameMode(msg.modeId, msg.newName);

      console.log('🌉 [Desktop Bridge] Mode renamed from "' + oldName + '" to "' + msg.newName + '"');

      var serializedCol = serializeCollection(collection);
      serializedCol.oldName = oldName;
      figma.ui.postMessage({
        type: 'RENAME_MODE_RESULT',
        requestId: msg.requestId,
        success: true,
        collection: serializedCol,
        oldName: oldName
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Rename mode error:', error);
      figma.ui.postMessage({
        type: 'RENAME_MODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // REFRESH_VARIABLES - Re-fetch and send all variables data
  // ============================================================================
  else if (msg.type === 'REFRESH_VARIABLES') {
    try {
      console.log('🌉 [Desktop Bridge] Refreshing variables data...');

      var variables = await figma.variables.getLocalVariablesAsync();
      var collections = await figma.variables.getLocalVariableCollectionsAsync();

      var variablesData = {
        success: true,
        timestamp: Date.now(),
        fileKey: figma.fileKey || null,
        variables: variables.map(serializeVariable),
        variableCollections: collections.map(serializeCollection)
      };

      // Update the UI's cached data
      figma.ui.postMessage({
        type: 'VARIABLES_DATA',
        data: variablesData
      });

      // Also send as a response to the request
      figma.ui.postMessage({
        type: 'REFRESH_VARIABLES_RESULT',
        requestId: msg.requestId,
        success: true,
        data: variablesData
      });

      console.log('🌉 [Desktop Bridge] Variables refreshed:', variables.length, 'variables in', collections.length, 'collections');

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Refresh variables error:', error);
      figma.ui.postMessage({
        type: 'REFRESH_VARIABLES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // GET_COMPONENT - Existing read operation
  // ============================================================================
  else if (msg.type === 'GET_COMPONENT') {
    try {
      console.log(`🌉 [Desktop Bridge] Fetching component: ${msg.nodeId}`);

      const node = await figma.getNodeByIdAsync(msg.nodeId);

      if (!node) {
        throw new Error(`Node not found: ${msg.nodeId}`);
      }

      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET' && node.type !== 'INSTANCE') {
        throw new Error(`Node is not a component. Type: ${node.type}`);
      }

      // Detect if this is a variant (COMPONENT inside a COMPONENT_SET)
      // Note: Can't use optional chaining (?.) - Figma plugin sandbox doesn't support it
      const isVariant = node.type === 'COMPONENT' && node.parent && node.parent.type === 'COMPONENT_SET';

      // Extract component data including description fields and annotations
      const componentData = {
        success: true,
        timestamp: Date.now(),
        nodeId: msg.nodeId,
        component: {
          id: node.id,
          name: node.name,
          type: node.type,
          // Variants CAN have their own description
          description: node.description || null,
          descriptionMarkdown: node.descriptionMarkdown || null,
          visible: node.visible,
          locked: node.locked,
          // Dev Mode annotations
          annotations: node.annotations || [],
          // Flag to indicate if this is a variant
          isVariant: isVariant,
          // For component sets and non-variant components only (variants cannot access this)
          componentPropertyDefinitions: (node.type === 'COMPONENT_SET' || (node.type === 'COMPONENT' && !isVariant))
            ? node.componentPropertyDefinitions
            : undefined,
          // Get children info (lightweight) — include SLOT nodes; skip unresolvable slot sublayers
          children: node.children ? node.children.reduce((acc, child) => {
            try {
              var childInfo = { id: child.id, name: child.name, type: child.type };
              if (child.type === 'SLOT') {
                childInfo.isSlot = true;
                try {
                  if (child.componentPropertyReferences && child.componentPropertyReferences.slotContentId) {
                    childInfo.propertyKey = child.componentPropertyReferences.slotContentId;
                  }
                } catch (e) { /* ignore */ }
                try {
                  childInfo.childCount = child.children ? child.children.length : 0;
                } catch (e) { /* ignore */ }
              }
              acc.push(childInfo);
            } catch (e) { /* slot sublayer or table cell — skip */ }
            return acc;
          }, []) : undefined
        }
      };

      console.log(`🌉 [Desktop Bridge] Component data ready. Has description: ${!!componentData.component.description}, annotations: ${componentData.component.annotations.length}`);

      // Send to UI
      figma.ui.postMessage({
        type: 'COMPONENT_DATA',
        requestId: msg.requestId, // Echo back the request ID
        data: componentData
      });

    } catch (error) {
      console.error(`🌉 [Desktop Bridge] Error fetching component:`, error);
      figma.ui.postMessage({
        type: 'COMPONENT_ERROR',
        requestId: msg.requestId,
        error: error.message || String(error)
      });
    }
  }

  // ============================================================================
  // ANALYZE_COMPONENT_SET - Variant state machine + cross-variant diff
  // For COMPONENT_SET nodes: maps variant states to CSS pseudo-classes,
  // computes visual diffs between default and other variants, and extracts
  // the component API surface (props, slots, conditional elements).
  // ============================================================================
  else if (msg.type === 'ANALYZE_COMPONENT_SET') {
    try {
      console.log('🌉 [Desktop Bridge] Analyzing component set: ' + msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) throw new Error('Node not found: ' + msg.nodeId);
      if (node.type !== 'COMPONENT_SET') throw new Error('Node is not a COMPONENT_SET. Type: ' + node.type);

      // Build variable name lookup
      var varNameMap = {};
      try {
        var allVars = await figma.variables.getLocalVariablesAsync();
        var allColls = await figma.variables.getLocalVariableCollectionsAsync();
        var collMap = {};
        for (var ci = 0; ci < allColls.length; ci++) collMap[allColls[ci].id] = allColls[ci].name;
        for (var vi = 0; vi < allVars.length; vi++) {
          var v = allVars[vi];
          varNameMap[v.id] = { name: v.name, collection: collMap[v.variableCollectionId] || null, type: v.resolvedType };
        }
      } catch(e) {}

      function resolveVarId(id) {
        return varNameMap[id] ? varNameMap[id].name : id;
      }

      function resolveBoundColor(bv) {
        if (!bv) return null;
        // Handle array format (fills/strokes)
        if (Array.isArray(bv)) {
          return bv.length > 0 && bv[0].id ? resolveVarId(bv[0].id) : null;
        }
        // Handle object format
        if (bv.id) return resolveVarId(bv.id);
        if (bv.color && bv.color.id) return resolveVarId(bv.color.id);
        return null;
      }

      function round2(n) {
        return typeof n === 'number' && !isNaN(n) ? Math.round(n * 100) / 100 : undefined;
      }

      // A paint list as one comparable string: the bound token or hex for a
      // solid, the stops for a gradient, 'image'/'video' otherwise. Paint
      // opacity below 1 is appended ('@0.5'), extra visible paints as '+N'.
      // Without this, gradients, images and a stroke faded to 0 diff as equal.
      function paintSig(paints, bound) {
        if (!paints || typeof paints === 'symbol' || !paints.length) return null;
        var vis = [];
        for (var pi = 0; pi < paints.length; pi++) {
          if (paints[pi].visible !== false) vis.push(pi);
        }
        if (!vis.length) return null;
        var p = paints[vis[0]];
        var tok = null;
        if (p.boundVariables && p.boundVariables.color && p.boundVariables.color.id) tok = resolveVarId(p.boundVariables.color.id);
        else if (Array.isArray(bound) && bound[vis[0]] && bound[vis[0]].id) tok = resolveVarId(bound[vis[0]].id);
        var s;
        if (tok) s = tok;
        else if (p.type === 'SOLID' && p.color) s = colorHex(p.color);
        else if (p.type && p.type.indexOf('GRADIENT_') === 0) {
          s = p.type.slice(9).toLowerCase() + '-gradient(' + (p.gradientStops || []).map(function(g) { return colorHex(g.color); }).join(', ') + ')';
        } else s = (p.type || 'paint').toLowerCase();
        if (typeof p.opacity === 'number' && p.opacity < 1) s += ' @' + round2(p.opacity);
        if (vis.length > 1) s += ' +' + (vis.length - 1);
        return s;
      }

      // Corner radius as a number, or 'tl tr br bl' when corners differ;
      // bound corners use the token name. undefined for nodes without corners.
      var CORNERS = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
      function radiusSig(n) {
        try {
          var bv = n.boundVariables || {};
          var vals = [];
          for (var ri = 0; ri < CORNERS.length; ri++) {
            var b = bv[CORNERS[ri]];
            var val = b && b.id ? resolveVarId(b.id) : round2(n[CORNERS[ri]]);
            if (val === undefined) return undefined;
            vals.push(val);
          }
          return vals[0] === vals[1] && vals[1] === vals[2] && vals[2] === vals[3] ? vals[0] : vals.join(' ');
        } catch (e) { return undefined; }
      }

      // Tokens bound to anything other than paints and corners (padding, gap,
      // width, font size...). A variant can swap the token while the value in
      // the current mode stays the same.
      var SKIP_BOUND = { fills: 1, strokes: 1, effects: 1, componentProperties: 1, textRangeFills: 1, topLeftRadius: 1, topRightRadius: 1, bottomLeftRadius: 1, bottomRightRadius: 1 };
      function boundTokens(n) {
        var out = null;
        try {
          var bv = n.boundVariables || {};
          for (var bk in bv) {
            if (SKIP_BOUND[bk]) continue;
            var tk = resolveBoundColor(bv[bk]);
            if (tk) {
              if (!out) out = {};
              out[bk] = tk;
            }
          }
        } catch (e) {}
        return out;
      }

      // Keys whose values differ between two token maps (null = removed).
      function diffTokens(a, b) {
        a = a || {};
        b = b || {};
        var out = null;
        var k;
        for (k in a) if (a[k] !== b[k]) { if (!out) out = {}; out[k] = a[k]; }
        for (k in b) if (!(k in a)) { if (!out) out = {}; out[k] = null; }
        return out;
      }

      function shortHash(str) {
        var h = 5381;
        for (var hi = 0; hi < str.length; hi++) h = ((h << 5) + h + str.charCodeAt(hi)) | 0;
        return (h >>> 0).toString(16);
      }

      function textValue(v, fmt) {
        if (v === undefined || v === null) return null;
        if (typeof v === 'symbol') return 'mixed';
        return fmt ? fmt(v) : v;
      }
      function unitValue(u) {
        if (u.unit === 'AUTO') return 'auto';
        return round2(u.value) + (u.unit === 'PERCENT' ? '%' : 'px');
      }

      // Extract visual signature from a variant for diffing
      async function extractSignature(variant) {
        var sig = {};

        // Find the main interactive element — prioritize by: has strokes (input fields),
        // is a FRAME with fills and strokes, or is the largest visible non-text child
        var mainChild = null;
        if (variant.children) {
          // First pass: find child with strokes (likely the input/interactive element)
          for (var i = 0; i < variant.children.length; i++) {
            var child = variant.children[i];
            try {
              if (child.visible !== false && child.type !== 'TEXT' && child.strokes && child.strokes.length > 0) {
                mainChild = child;
                break;
              }
            } catch(e) {}
          }
          // Fallback: first visible FRAME child
          if (!mainChild) {
            for (var i2 = 0; i2 < variant.children.length; i2++) {
              var c2 = variant.children[i2];
              try {
                if (c2.visible !== false && c2.type === 'FRAME') {
                  mainChild = c2;
                  break;
                }
              } catch(e) {}
            }
          }
        }

        // No stroked/frame child: the variant itself carries the visuals
        // (e.g. a button whose fill sits on the component).
        if (!mainChild) mainChild = variant;
        // Layer paths whose values the top-level fields already report.
        sig._mainPath = mainChild === variant ? null : mainChild.name;
        sig._textPath = null;

        // Geometry and structure, so variants that differ in size or content
        // (2 icons vs 6 icons) don't diff as identical (#121).
        sig.width = Math.round(variant.width * 100) / 100;
        sig.height = Math.round(variant.height * 100) / 100;
        sig.children = variant.children ? variant.children.map(function(c) { return c.name; }) : [];

        if (mainChild) {
              var child = mainChild;
              // This is the main interactive frame
              try {
                var bv = child.boundVariables || {};
                sig.fillToken = resolveBoundColor(bv.fills);
                sig.strokeToken = resolveBoundColor(bv.strokes);
                sig.strokeWeight = child.strokeWeight;

                // Raw paint as fallback (hex, gradient or image, with opacity)
                if (!sig.fillToken) sig.fillHex = paintSig(child.fills) || undefined;
                if (!sig.strokeToken) sig.strokeHex = paintSig(child.strokes) || undefined;
                sig.effects = child.effects && child.effects.length > 0 ? child.effects : null;
                sig.opacity = child.opacity < 1 ? Math.round(child.opacity * 100) / 100 : null;
                var mr = radiusSig(child);
                if (mr !== undefined) sig.cornerRadius = mr;
              } catch(e) {}

              // Check text children for color changes
              if (child.children) {
                for (var t = 0; t < child.children.length; t++) {
                  var textChild = child.children[t];
                  if (textChild.type === 'TEXT') {
                    sig._textPath = sig._mainPath ? sig._mainPath + ' › ' + textChild.name : textChild.name;
                    try {
                      var tbv = textChild.boundVariables || {};
                      sig.textToken = resolveBoundColor(tbv.fills);
                      if (!sig.textToken) sig.textHex = paintSig(textChild.fills) || undefined;
                    } catch(e) {}
                    break; // First text node is enough
                  }
                }
              }
        }

        // Top-level layers that are hidden. _visible keeps every child's
        // visibility so the diff can compare both directions.
        sig.visibilityChanges = {};
        sig._visible = {};
        if (variant.children) {
          for (var j = 0; j < variant.children.length; j++) {
            var ch = variant.children[j];
            try {
              sig._visible[ch.name] = ch.visible !== false;
              if (!ch.visible) sig.visibilityChanges[ch.name] = false;
            } catch(e) {}
          }
        }

        // Opacity on the variant itself (a disabled state often lives here,
        // not on any child).
        sig.variantOpacity = variant.opacity < 1 ? Math.round(variant.opacity * 100) / 100 : null;

        // Fill and stroke on the variant itself. A button's background usually
        // sits here while the main layer picked above is its label frame, so
        // without these a hover that only changes the background diffs as
        // no change.
        sig.variantFill = null;
        sig.variantStroke = null;
        try {
          var vbv = variant.boundVariables || {};
          sig.variantFill = paintSig(variant.fills, vbv.fills);
          sig.variantStroke = paintSig(variant.strokes, vbv.strokes);
          var vr = radiusSig(variant);
          if (vr !== undefined) sig.variantRadius = vr;
        } catch(e) {}
        // Non-paint tokens on the variant (padding, gap, size). Diff-only.
        sig._tokens = boundTokens(variant);

        // Auto-layout on the variant itself, so axes like Alignment or Density
        // that only change layout don't diff as identical. Diff-only.
        sig._layout = null;
        try {
          if (variant.layoutMode && variant.layoutMode !== 'NONE') {
            sig._layout = {
              layoutMode: variant.layoutMode,
              primaryAxisAlignItems: variant.primaryAxisAlignItems,
              counterAxisAlignItems: variant.counterAxisAlignItems,
              itemSpacing: variant.itemSpacing,
              paddingTop: variant.paddingTop,
              paddingRight: variant.paddingRight,
              paddingBottom: variant.paddingBottom,
              paddingLeft: variant.paddingLeft
            };
          }
        } catch(e) {}

        // Nested layers, keyed by path. State changes often sit below the
        // first child (a checked radio swaps the icon instance; its vector's
        // fill token changes), which the fields above never see. Only used
        // for diffing — stripped from the response.
        sig._layers = {};
        var layerCount = 0;
        async function walkLayers(parent, prefix, depth) {
          if (!parent.children || depth > 4) return;
          var parentAuto = parent.layoutMode && parent.layoutMode !== 'NONE';
          var seen = {};
          for (var li = 0; li < parent.children.length && layerCount < 300; li++) {
            var ln = parent.children[li];
            var nm = ln.name;
            seen[nm] = (seen[nm] || 0) + 1;
            if (seen[nm] > 1) nm = nm + '#' + seen[nm];
            var path = prefix ? prefix + ' › ' + nm : nm;
            var entry = {};
            layerCount++;
            try {
              var lbv = ln.boundVariables || {};
              entry.fill = paintSig(ln.fills, lbv.fills);
              entry.stroke = paintSig(ln.strokes, lbv.strokes);
              entry.strokeWeight = entry.stroke ? (typeof ln.strokeWeight === 'number' ? ln.strokeWeight : null) : null;
              entry.opacity = ln.opacity < 1 ? Math.round(ln.opacity * 100) / 100 : null;
              entry.visible = ln.visible !== false;
              entry.radius = radiusSig(ln);
              entry.tokens = boundTokens(ln);
              // Size always; position only where auto-layout doesn't place
              // the layer (a tooltip's pointer moving between corners).
              entry.width = round2(ln.width);
              entry.height = round2(ln.height);
              if (!parentAuto || ln.layoutPositioning === 'ABSOLUTE') {
                entry.x = round2(ln.x);
                entry.y = round2(ln.y);
              }
              entry.rotation = ln.rotation ? round2(ln.rotation) : undefined;
              if (ln.type === 'ELLIPSE' && ln.arcData) {
                entry.shape = 'arc ' + round2(ln.arcData.startingAngle) + ' ' + round2(ln.arcData.endingAngle) + ' ' + round2(ln.arcData.innerRadius);
              } else if (ln.type === 'VECTOR' && ln.vectorPaths) {
                entry.shape = 'path#' + shortHash(JSON.stringify(ln.vectorPaths));
              }
              if (ln.type === 'TEXT') {
                entry.text = textValue(ln.characters, function(c) { return c.length > 80 ? c.slice(0, 80) + '…' : c; });
                entry.fontSize = textValue(ln.fontSize, round2);
                entry.font = textValue(ln.fontName, function(f) { return f.family + ' ' + f.style; });
                entry.textDecoration = textValue(ln.textDecoration);
                entry.textCase = textValue(ln.textCase);
                entry.lineHeight = textValue(ln.lineHeight, unitValue);
                entry.letterSpacing = textValue(ln.letterSpacing, unitValue);
              }
            } catch(e) {}
            if (ln.type === 'INSTANCE') {
              try {
                var mc = await ln.getMainComponentAsync();
                entry.component = mc ? mc.name : null;
              } catch(e) {}
            }
            sig._layers[path] = entry;
            await walkLayers(ln, path, depth + 1);
          }
        }
        await walkLayers(variant, '', 0);

        return sig;
      }

      function colorHex(c) {
        return '#' + Math.round(c.r*255).toString(16).padStart(2,'0') + Math.round(c.g*255).toString(16).padStart(2,'0') + Math.round(c.b*255).toString(16).padStart(2,'0');
      }

      // Signature as returned to the caller, without the diff-only fields.
      function publicSignature(sig) {
        var out = {};
        for (var k in sig) {
          if (k.charAt(0) !== '_') out[k] = sig[k];
        }
        return out;
      }

      // Parse variant property definitions
      var propDefs = node.componentPropertyDefinitions || {};
      var variantAxes = {};
      var componentProps = {};
      var propKeys = Object.keys(propDefs);
      for (var pk = 0; pk < propKeys.length; pk++) {
        var propKey = propKeys[pk];
        var propDef = propDefs[propKey];
        if (propDef.type === 'VARIANT') {
          variantAxes[propKey] = propDef.variantOptions || [];
        } else {
          componentProps[propKey] = {
            type: propDef.type,
            defaultValue: propDef.defaultValue
          };
        }
      }

      // CSS pseudo-class mapping for state variants
      var stateMapping = {
        'default': null,
        'hover': ':hover',
        'focus': ':focus-visible',
        'focus-visible': ':focus-visible',
        'focused': ':focus-visible',
        'active': ':active',
        'pressed': ':active',
        'disabled': ':disabled, [aria-disabled="true"]',
        'error': '[aria-invalid="true"]',
        'invalid': '[aria-invalid="true"]',
        'filled': '.has-value',
        'selected': '[aria-selected="true"]',
        'checked': ':checked',
        'loading': '[aria-busy="true"]',
        'readonly': '[readonly]',
        'open': '[aria-expanded="true"]',
        'closed': '[aria-expanded="false"]'
      };

      // Analyze variants grouped by axes
      var variants = node.children || [];
      var defaultVariant = null;
      var stateAxis = null;
      var sizeAxis = null;

      // Detect which axis is "state" and which is "size"
      var axisKeys = Object.keys(variantAxes);
      for (var ak = 0; ak < axisKeys.length; ak++) {
        var axisName = axisKeys[ak].toLowerCase();
        var axisValues = variantAxes[axisKeys[ak]];
        if (axisName === 'state' || axisName === 'status' || axisName === 'interaction') {
          stateAxis = axisKeys[ak];
        } else if (axisName === 'size' || axisName === 'scale') {
          sizeAxis = axisKeys[ak];
        }
      }

      // Build state machine from variants
      var stateMachine = { states: {}, defaultState: null, cssMapping: {} };
      var defaultSig = null;

      // Find the default variant (#121). Start from Figma's own default (the
      // set's top-left variant). With a state axis, prefer the variant that
      // matches it on every other axis but is in a resting state. Variant
      // names are "Axis=Value, ..." in the author's casing, so compare values
      // case-insensitively.
      function parseAxes(name) {
        var out = {};
        var segs = name.split(',');
        for (var si = 0; si < segs.length; si++) {
          var kv = segs[si].split('=');
          if (kv.length === 2) out[kv[0].trim()] = kv[1].trim();
        }
        return out;
      }
      var figmaDefault = null;
      try { figmaDefault = node.defaultVariant || null; } catch (e) {}
      if (!figmaDefault && variants.length > 0) figmaDefault = variants[0];
      defaultVariant = figmaDefault;
      if (stateAxis && figmaDefault) {
        var restingStates = ['default', 'rest', 'resting', 'enabled', 'idle', 'normal', 'base'];
        var baseAxes = parseAxes(figmaDefault.name);
        var currentState = (baseAxes[stateAxis] || '').toLowerCase();
        if (restingStates.indexOf(currentState) === -1) {
          for (var di = 0; di < variants.length; di++) {
            var cand = parseAxes(variants[di].name);
            var sameOtherAxes = true;
            for (var bk in baseAxes) {
              if (bk !== stateAxis && cand[bk] !== baseAxes[bk]) { sameOtherAxes = false; break; }
            }
            if (sameOtherAxes && restingStates.indexOf((cand[stateAxis] || '').toLowerCase()) !== -1) {
              defaultVariant = variants[di];
              break;
            }
          }
        }
      }
      if (defaultVariant) {
        defaultSig = await extractSignature(defaultVariant);
      }

      // Process each variant and compute diff from default
      var variantDiffs = [];
      for (var vdi = 0; vdi < variants.length; vdi++) {
        var variant = variants[vdi];
        var sig = await extractSignature(variant);

        // Parse variant name to extract axis values
        var axisParts = variant.name.split(', ');
        var axisValues = {};
        for (var ap = 0; ap < axisParts.length; ap++) {
          var parts = axisParts[ap].split('=');
          if (parts.length === 2) axisValues[parts[0].trim()] = parts[1].trim();
        }

        var stateValue = stateAxis ? (axisValues[stateAxis] || 'default') : 'default';
        var cssSelector = stateMapping[stateValue.toLowerCase()] || null;

        // Compute diff from default
        var diff = {};
        if (defaultSig && variant.id !== (defaultVariant ? defaultVariant.id : null)) {
          if (sig.fillToken !== defaultSig.fillToken) diff.fillToken = sig.fillToken || sig.fillHex;
          if (sig.strokeToken !== defaultSig.strokeToken) diff.strokeToken = sig.strokeToken || sig.strokeHex;
          if (sig.strokeWeight !== defaultSig.strokeWeight) diff.strokeWeight = sig.strokeWeight;
          if (sig.textToken !== defaultSig.textToken) diff.textToken = sig.textToken || sig.textHex;
          if (sig.opacity !== defaultSig.opacity) diff.opacity = sig.opacity;
          if (JSON.stringify(sig.effects) !== JSON.stringify(defaultSig.effects)) diff.effects = sig.effects;
          if (sig.width !== defaultSig.width) diff.width = sig.width;
          if (sig.height !== defaultSig.height) diff.height = sig.height;
          if (sig.fillHex !== defaultSig.fillHex && !diff.fillToken) diff.fillHex = sig.fillHex;
          if (sig.strokeHex !== defaultSig.strokeHex && !diff.strokeToken) diff.strokeHex = sig.strokeHex;
          if (sig.textHex !== defaultSig.textHex && !diff.textToken) diff.textHex = sig.textHex;
          if (sig.cornerRadius !== defaultSig.cornerRadius) diff.cornerRadius = sig.cornerRadius === undefined ? null : sig.cornerRadius;
          if (JSON.stringify(sig.children) !== JSON.stringify(defaultSig.children)) {
            diff.children = {
              count: sig.children.length,
              added: sig.children.filter(function(n) { return defaultSig.children.indexOf(n) === -1; }),
              removed: defaultSig.children.filter(function(n) { return sig.children.indexOf(n) === -1; })
            };
          }
          // Top-level layers present in both whose visibility differs
          // (false = hidden in this variant, true = shown here but hidden in
          // the default).
          for (var vk in sig._visible) {
            if (Object.prototype.hasOwnProperty.call(defaultSig._visible, vk) && sig._visible[vk] !== defaultSig._visible[vk]) {
              if (!diff.visibilityChanges) diff.visibilityChanges = {};
              diff.visibilityChanges[vk] = sig._visible[vk];
            }
          }
          if ((sig._mainPath || defaultSig._mainPath) && sig.variantOpacity !== defaultSig.variantOpacity) diff.variantOpacity = sig.variantOpacity === null ? 1 : sig.variantOpacity;
          // When both use the variant as the main layer, fillToken/strokeToken
          // above already report these.
          if (sig._mainPath || defaultSig._mainPath) {
            if (sig.variantFill !== defaultSig.variantFill) diff.variantFill = sig.variantFill;
            if (sig.variantStroke !== defaultSig.variantStroke) diff.variantStroke = sig.variantStroke;
            if (sig.variantRadius !== defaultSig.variantRadius) diff.variantRadius = sig.variantRadius === undefined ? null : sig.variantRadius;
          }
          var tokenDiff = diffTokens(sig._tokens, defaultSig._tokens);
          if (tokenDiff) diff.tokens = tokenDiff;

          // Nested layer changes, skipping values the fields above already
          // report so one change isn't listed twice.
          if (sig._layout || defaultSig._layout) {
            var la = sig._layout || {};
            var lb = defaultSig._layout || {};
            var layoutDiff = null;
            var layoutKeys = ['layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
            for (var lk = 0; lk < layoutKeys.length; lk++) {
              if (la[layoutKeys[lk]] !== lb[layoutKeys[lk]]) {
                if (!layoutDiff) layoutDiff = {};
                layoutDiff[layoutKeys[lk]] = la[layoutKeys[lk]] === undefined ? null : la[layoutKeys[lk]];
              }
            }
            if (layoutDiff) diff.layout = layoutDiff;
          }

          var layerProps = ['fill', 'stroke', 'strokeWeight', 'opacity', 'visible', 'component', 'radius', 'width', 'height', 'x', 'y', 'rotation', 'shape', 'text', 'fontSize', 'font', 'textDecoration', 'textCase', 'lineHeight', 'letterSpacing'];
          // Reported for the main layer by fillToken/strokeToken/opacity/cornerRadius.
          var mainCovered = { fill: 1, stroke: 1, strokeWeight: 1, opacity: 1, radius: 1 };
          for (var lp in sig._layers) {
            var dl = defaultSig._layers[lp];
            if (!dl) continue;
            var sl = sig._layers[lp];
            var isTop = lp.indexOf(' › ') === -1;
            var ld = null;
            for (var pi = 0; pi < layerProps.length; pi++) {
              var prop = layerProps[pi];
              if (prop === 'visible' && isTop) continue;
              if (lp === sig._mainPath && mainCovered[prop]) continue;
              if (lp === sig._textPath && prop === 'fill') continue;
              if (sl[prop] !== dl[prop]) {
                if (!ld) ld = {};
                ld[prop] = sl[prop] === undefined ? null : sl[prop];
              }
            }
            var ltd = diffTokens(sl.tokens, dl.tokens);
            if (ltd) {
              if (!ld) ld = {};
              ld.tokens = ltd;
            }
            if (ld) {
              if (!diff.layers) diff.layers = {};
              diff.layers[lp] = ld;
            }
          }
          var nestedAdded = [];
          var nestedRemoved = [];
          for (var ap2 in sig._layers) {
            if (ap2.indexOf(' › ') !== -1 && !defaultSig._layers[ap2] && nestedAdded.length < 20) nestedAdded.push(ap2);
          }
          for (var rp2 in defaultSig._layers) {
            if (rp2.indexOf(' › ') !== -1 && !sig._layers[rp2] && nestedRemoved.length < 20) nestedRemoved.push(rp2);
          }
          if (nestedAdded.length) diff.layersAdded = nestedAdded;
          if (nestedRemoved.length) diff.layersRemoved = nestedRemoved;
        }

        variantDiffs.push({
          name: variant.name,
          id: variant.id,
          axes: axisValues,
          state: stateValue,
          cssSelector: cssSelector,
          diffFromDefault: Object.keys(diff).length > 0 ? diff : null,
          signature: publicSignature(sig)
        });

        // Build CSS mapping
        if (cssSelector) {
          stateMachine.cssMapping[stateValue] = cssSelector;
        }
        if (!stateMachine.states[stateValue]) {
          stateMachine.states[stateValue] = [];
        }
        stateMachine.states[stateValue].push(variant.id);
      }

      if (defaultVariant) {
        var defaultAxes = parseAxes(defaultVariant.name);
        stateMachine.defaultState = stateAxis ? (defaultAxes[stateAxis] || 'default') : 'default';
        stateMachine.defaultVariant = { id: defaultVariant.id, name: defaultVariant.name };
        stateMachine.defaultSignature = publicSignature(defaultSig);
      }

      var result = {
        nodeId: node.id,
        nodeName: node.name,
        variantCount: variants.length,
        variantAxes: variantAxes,
        componentProps: componentProps,
        slots: extractSlots(node),
        stateMachine: stateMachine,
        variants: variantDiffs,
        ai_instruction: 'Use cssMapping to implement interaction states. diffFromDefault shows only what changes per state — apply these as CSS pseudo-class or attribute overrides. componentProps maps to React/Vue component props (BOOLEAN → boolean prop, TEXT → string prop, INSTANCE_SWAP → ReactNode/slot prop). slots lists Figma SLOT properties — implement each as a named slot / children prop (React: {children} or a named ReactNode prop; Web Components: <slot name>); preferredValues lists the components a slot accepts, and limitViolations flags content that breaks the slot\'s min/max rules. To populate a slot on an instance, use figma_append_to_slot (not figma_set_instance_properties).'
      };

      console.log('🌉 [Desktop Bridge] Component set analysis complete. ' + variants.length + ' variants, ' + Object.keys(stateMachine.cssMapping).length + ' CSS mappings');

      figma.ui.postMessage({
        type: 'ANALYZE_COMPONENT_SET_RESULT',
        requestId: msg.requestId,
        success: true,
        data: result
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Analyze component set error:', errorMsg);
      figma.ui.postMessage({
        type: 'ANALYZE_COMPONENT_SET_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // DEEP_GET_COMPONENT - Full recursive component extraction for code generation
  // Extracts visual properties, boundVariables, reactions, instance references,
  // and annotations at every level of the component tree.
  // ============================================================================
  else if (msg.type === 'DEEP_GET_COMPONENT') {
    try {
      var maxDepth = msg.depth;
      if (maxDepth === undefined || maxDepth === null) maxDepth = 10;
      if (maxDepth <= 0) maxDepth = Infinity; // 0 or negative = unlimited depth
      console.log('🌉 [Desktop Bridge] Deep component fetch: ' + msg.nodeId + ' (depth: ' + maxDepth + ')');

      var rootNode = await figma.getNodeByIdAsync(msg.nodeId);
      if (!rootNode) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      // Build a variable name lookup map for resolving boundVariables
      var varNameMap = {};
      try {
        var allVars = await figma.variables.getLocalVariablesAsync();
        var allCollections = await figma.variables.getLocalVariableCollectionsAsync();
        var collectionMap = {};
        for (var ci = 0; ci < allCollections.length; ci++) {
          collectionMap[allCollections[ci].id] = allCollections[ci].name;
        }
        for (var vi = 0; vi < allVars.length; vi++) {
          var v = allVars[vi];
          varNameMap[v.id] = {
            name: v.name,
            resolvedType: v.resolvedType,
            collection: collectionMap[v.variableCollectionId] || null,
            scopes: v.scopes || [],
            codeSyntax: v.codeSyntax || {}
          };
        }
      } catch (e) {
        console.log('🌉 [Desktop Bridge] Could not build variable map: ' + e.message);
      }

      // Resolve boundVariables to token names
      function resolveBoundVars(bv) {
        if (!bv) return null;
        var resolved = {};
        var keys = Object.keys(bv);
        for (var k = 0; k < keys.length; k++) {
          var prop = keys[k];
          var binding = bv[prop];
          if (Array.isArray(binding)) {
            resolved[prop] = [];
            for (var bi = 0; bi < binding.length; bi++) {
              var b = binding[bi];
              if (b && b.id) {
                var info = varNameMap[b.id];
                resolved[prop].push(info ? { id: b.id, name: info.name, collection: info.collection, resolvedType: info.resolvedType, codeSyntax: info.codeSyntax } : { id: b.id });
              }
            }
          } else if (binding && binding.id) {
            var info = varNameMap[binding.id];
            resolved[prop] = info ? { id: binding.id, name: info.name, collection: info.collection, resolvedType: info.resolvedType, codeSyntax: info.codeSyntax } : { id: binding.id };
          }
        }
        return Object.keys(resolved).length > 0 ? resolved : null;
      }

      // Extract visual properties from a node
      function extractNodeProps(n) {
        var props = {};

        // Layout
        if (n.layoutMode) props.layoutMode = n.layoutMode;
        if (n.primaryAxisSizingMode) props.primaryAxisSizingMode = n.primaryAxisSizingMode;
        if (n.counterAxisSizingMode) props.counterAxisSizingMode = n.counterAxisSizingMode;
        if (n.layoutSizingHorizontal) props.layoutSizingHorizontal = n.layoutSizingHorizontal;
        if (n.layoutSizingVertical) props.layoutSizingVertical = n.layoutSizingVertical;
        if (n.primaryAxisAlignItems) props.primaryAxisAlignItems = n.primaryAxisAlignItems;
        if (n.counterAxisAlignItems) props.counterAxisAlignItems = n.counterAxisAlignItems;
        if (n.paddingLeft !== undefined && n.paddingLeft !== 0) props.paddingLeft = n.paddingLeft;
        if (n.paddingRight !== undefined && n.paddingRight !== 0) props.paddingRight = n.paddingRight;
        if (n.paddingTop !== undefined && n.paddingTop !== 0) props.paddingTop = n.paddingTop;
        if (n.paddingBottom !== undefined && n.paddingBottom !== 0) props.paddingBottom = n.paddingBottom;
        if (n.itemSpacing !== undefined && n.itemSpacing !== 0) props.itemSpacing = n.itemSpacing;
        if (n.counterAxisSpacing !== undefined && n.counterAxisSpacing !== 0) props.counterAxisSpacing = n.counterAxisSpacing;
        if (n.layoutWrap && n.layoutWrap !== 'NO_WRAP') props.layoutWrap = n.layoutWrap;
        if (n.minWidth !== undefined) props.minWidth = n.minWidth;
        if (n.maxWidth !== undefined) props.maxWidth = n.maxWidth;
        if (n.minHeight !== undefined) props.minHeight = n.minHeight;
        if (n.maxHeight !== undefined) props.maxHeight = n.maxHeight;
        if (n.clipsContent) props.clipsContent = true;

        // Visual
        try {
          if (n.fills && n.fills !== figma.mixed && n.fills.length > 0) props.fills = n.fills;
        } catch (e) { /* mixed fills */ }
        try {
          if (n.strokes && n.strokes.length > 0) props.strokes = n.strokes;
        } catch (e) {}
        if (n.strokeWeight !== undefined && n.strokeWeight !== 0 && n.strokeWeight !== figma.mixed) props.strokeWeight = n.strokeWeight;
        if (n.cornerRadius !== undefined && n.cornerRadius !== 0 && n.cornerRadius !== figma.mixed) props.cornerRadius = n.cornerRadius;
        try {
          if (n.effects && n.effects.length > 0) props.effects = n.effects;
        } catch (e) {}
        if (n.opacity !== undefined && n.opacity < 1) props.opacity = n.opacity;

        // Mixed corner radius -> per-corner radii (full info instead of dropping)
        try {
          if (n.cornerRadius === figma.mixed) {
            props.cornerRadius = 'MIXED';
            props.cornerRadiuses = {
              topLeft: n.topLeftRadius,
              topRight: n.topRightRadius,
              bottomRight: n.bottomRightRadius,
              bottomLeft: n.bottomLeftRadius
            };
          }
        } catch (e) {}
        // Mixed stroke weight -> per-side weights
        try {
          if (n.strokeWeight === figma.mixed) {
            props.strokeWeight = 'MIXED';
            props.strokeWeights = {
              top: n.strokeTopWeight,
              right: n.strokeRightWeight,
              bottom: n.strokeBottomWeight,
              left: n.strokeLeftWeight
            };
          }
        } catch (e) {}

        // Typography
        if (n.type === 'TEXT') {
          try { props.characters = n.characters; } catch (e) {}
          try { if (n.fontSize !== figma.mixed) props.fontSize = n.fontSize; } catch (e) {}
          try { if (n.fontName !== figma.mixed) { props.fontFamily = n.fontName.family; props.fontStyle = n.fontName.style; } } catch (e) {}
          try { if (n.fontWeight !== figma.mixed) props.fontWeight = n.fontWeight; } catch (e) {}
          try { if (n.lineHeight !== figma.mixed) props.lineHeight = n.lineHeight; } catch (e) {}
          try { if (n.letterSpacing !== figma.mixed) props.letterSpacing = n.letterSpacing; } catch (e) {}
          try { if (n.textAlignHorizontal) props.textAlignHorizontal = n.textAlignHorizontal; } catch (e) {}
          try { if (n.textAlignVertical) props.textAlignVertical = n.textAlignVertical; } catch (e) {}
          try { if (n.textAutoResize && n.textAutoResize !== 'NONE') props.textAutoResize = n.textAutoResize; } catch (e) {}
          try { if (n.textTruncation && n.textTruncation !== 'DISABLED') props.textTruncation = n.textTruncation; } catch (e) {}
          try { if (n.textCase && n.textCase !== 'ORIGINAL') props.textCase = n.textCase; } catch (e) {}
          try { if (n.textDecoration && n.textDecoration !== 'NONE') props.textDecoration = n.textDecoration; } catch (e) {}

          // Expand mixed per-character styles into full per-range segments (no info loss).
          try {
            var _typoFields = ['fontName','fontSize','fontWeight','textDecoration','textCase','lineHeight','letterSpacing','fills','textStyleId','fillStyleId'];
            var _anyMixed = false;
            for (var _ti = 0; _ti < _typoFields.length; _ti++) {
              try { if (n[_typoFields[_ti]] === figma.mixed) { _anyMixed = true; break; } } catch (e2) {}
            }
            if (_anyMixed && typeof n.getStyledTextSegments === 'function') {
              props.styledSegments = n.getStyledTextSegments(_typoFields).map(function (s) {
                var o = { characters: s.characters, start: s.start, end: s.end };
                try { if (s.fontName) { o.fontFamily = s.fontName.family; o.fontStyle = s.fontName.style; } } catch (e3) {}
                if (s.fontSize !== undefined) o.fontSize = s.fontSize;
                if (s.fontWeight !== undefined) o.fontWeight = s.fontWeight;
                if (s.lineHeight !== undefined) o.lineHeight = s.lineHeight;
                if (s.letterSpacing !== undefined) o.letterSpacing = s.letterSpacing;
                if (s.textDecoration !== undefined) o.textDecoration = s.textDecoration;
                if (s.textCase !== undefined) o.textCase = s.textCase;
                if (s.fills !== undefined) o.fills = s.fills;
                if (s.textStyleId) o.textStyleId = s.textStyleId;
                if (s.fillStyleId) o.fillStyleId = s.fillStyleId;
                return o;
              });
            }
          } catch (e) {}
        }

        // Design tokens (resolved to names)
        try {
          var resolved = resolveBoundVars(n.boundVariables);
          if (resolved) props.boundVariables = resolved;
        } catch (e) {}

        // Prototype interactions
        try {
          if (n.reactions && n.reactions.length > 0) {
            props.reactions = n.reactions.map(function(r) {
              var reaction = { trigger: r.trigger };
              if (r.action) {
                reaction.action = { type: r.action.type };
                if (r.action.navigation) reaction.action.navigation = r.action.navigation;
                if (r.action.transition) reaction.action.transition = r.action.transition;
                if (r.action.destinationId) reaction.action.destinationId = r.action.destinationId;
              }
              return reaction;
            });
          }
        } catch (e) {}

        // Annotations
        try {
          if (n.annotations && n.annotations.length > 0) {
            props.annotations = n.annotations.map(function(a) {
              var ann = {};
              if (a.labelMarkdown) ann.labelMarkdown = a.labelMarkdown;
              else if (a.label) ann.label = a.label;
              if (a.properties) ann.properties = a.properties;
              if (a.categoryId) ann.categoryId = a.categoryId;
              return ann;
            });
          }
        } catch (e) {}

        // Component instance reference
        if (n.type === 'INSTANCE') {
          try {
            if (n.mainComponent) {
              props.mainComponent = {
                id: n.mainComponent.id,
                name: n.mainComponent.name,
                key: n.mainComponent.key || null,
                isVariant: n.mainComponent.parent && n.mainComponent.parent.type === 'COMPONENT_SET'
              };
              if (props.mainComponent.isVariant && n.mainComponent.parent) {
                props.mainComponent.componentSetName = n.mainComponent.parent.name;
                props.mainComponent.componentSetId = n.mainComponent.parent.id;
              }
            }
          } catch (e) {}
          try {
            if (n.componentProperties) props.componentProperties = n.componentProperties;
          } catch (e) {}
        }

        // Component definitions (for COMPONENT and COMPONENT_SET)
        if (n.type === 'COMPONENT_SET' || n.type === 'COMPONENT') {
          try {
            if (n.componentPropertyDefinitions) props.componentPropertyDefinitions = n.componentPropertyDefinitions;
          } catch (e) {}
          try {
            var devSlots = extractSlots(n);
            if (devSlots.length) props.slots = devSlots;
          } catch (e) {}
          if (n.type === 'COMPONENT' && n.variantProperties) {
            props.variantProperties = n.variantProperties;
          }
        }

        // Dimensions
        try {
          props.width = Math.round(n.width);
          props.height = Math.round(n.height);
        } catch (e) {}

        return props;
      }

      // Recursive tree walker
      function walkNode(n, currentDepth) {
        var nodeData = {
          id: n.id,
          name: n.name,
          type: n.type,
          visible: n.visible
        };

        // Skip invisible nodes (unless they're component set variants)
        if (!n.visible && n.type !== 'COMPONENT') {
          nodeData._hidden = true;
          return nodeData;
        }

        // Extract all properties
        var props = extractNodeProps(n);
        var propKeys = Object.keys(props);
        for (var pk = 0; pk < propKeys.length; pk++) {
          nodeData[propKeys[pk]] = props[propKeys[pk]];
        }

        // Recurse into children
        if (n.children && currentDepth < maxDepth) {
          nodeData.children = [];
          for (var i = 0; i < n.children.length; i++) {
            try {
              nodeData.children.push(walkNode(n.children[i], currentDepth + 1));
            } catch (e) {
              // Skip inaccessible slot sublayers
            }
          }
        } else if (n.children) {
          // At max depth, include lightweight child summary
          nodeData.childCount = n.children.length;
          nodeData._depthLimitReached = true;
        }

        return nodeData;
      }

      var result = walkNode(rootNode, 0);
      result._variableMapSize = Object.keys(varNameMap).length;
      result._maxDepthUsed = (maxDepth === Infinity) ? 'unlimited' : maxDepth;

      // figma.mixed is a Symbol; it cannot cross figma.ui.postMessage
      // (structuredClone throws "Cannot unwrap symbol"). Serialize with a
      // replacer that turns any Symbol into the string "MIXED", then send the
      // parsed (symbol-free) clone instead of the raw node tree.
      var resultJson = JSON.stringify(result, function (key, val) {
        return typeof val === 'symbol' ? 'MIXED' : val;
      });
      console.log('🌉 [Desktop Bridge] Deep component data: ' + Math.round(resultJson.length / 1024) + 'KB, vars resolved: ' + Object.keys(varNameMap).length);

      figma.ui.postMessage({
        type: 'DEEP_GET_COMPONENT_RESULT',
        requestId: msg.requestId,
        success: true,
        data: JSON.parse(resultJson)
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Deep component error:', errorMsg);
      figma.ui.postMessage({
        type: 'DEEP_GET_COMPONENT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // GET_LOCAL_COMPONENTS - Get all local components for design system manifest
  // ============================================================================
  else if (msg.type === 'GET_LOCAL_COMPONENTS') {
    try {
      console.log('🌉 [Desktop Bridge] Fetching all local components for manifest...');

      // Find all component sets and standalone components in the file
      var components = [];
      var componentSets = [];

      // Helper to extract component data
      function extractComponentData(node, isPartOfSet) {
        var data = {
          key: node.key,
          nodeId: node.id,
          name: node.name,
          type: node.type,
          description: node.description || null,
          width: node.width,
          height: node.height
        };

        // Get property definitions for non-variant components
        if (!isPartOfSet && node.componentPropertyDefinitions) {
          data.properties = [];
          var propDefs = node.componentPropertyDefinitions;
          for (var propName in propDefs) {
            if (propDefs.hasOwnProperty(propName)) {
              var propDef = propDefs[propName];
              data.properties.push({
                name: propName,
                type: propDef.type,
                defaultValue: propDef.defaultValue
              });
            }
          }
        }

        var compSlots = extractSlots(node);
        if (compSlots.length) data.slots = compSlots;

        return data;
      }

      // Helper to extract component set data with all variants
      function extractComponentSetData(node) {
        // The getter recomputes on every access; read it once per set
        var setPropDefs = node.componentPropertyDefinitions;
        var variantAxes = {};
        var variants = [];

        // Parse variant properties from children names — skip unresolvable slot sublayers
        if (node.children) {
          node.children.forEach(function(child) {
            try {
              if (child.type === 'COMPONENT') {
                // Parse variant name (e.g., "Size=md, State=default")
                var variantProps = {};
                var parts = child.name.split(',').map(function(p) { return p.trim(); });
                parts.forEach(function(part) {
                  var kv = part.split('=');
                  if (kv.length === 2) {
                    var key = kv[0].trim();
                    var value = kv[1].trim();
                    variantProps[key] = value;

                    // Track all values for each axis
                    if (!variantAxes[key]) {
                      variantAxes[key] = [];
                    }
                    if (variantAxes[key].indexOf(value) === -1) {
                      variantAxes[key].push(value);
                    }
                  }
                });

                variants.push({
                  key: child.key,
                  nodeId: child.id,
                  name: child.name,
                  description: child.description || null,
                  variantProperties: variantProps,
                  width: child.width,
                  height: child.height
                });
              }
            } catch (e) { /* slot sublayer — skip */ }
          });
        }

        // Convert variantAxes object to array format
        var axes = [];
        for (var axisName in variantAxes) {
          if (variantAxes.hasOwnProperty(axisName)) {
            axes.push({
              name: axisName,
              values: variantAxes[axisName]
            });
          }
        }

        return {
          key: node.key,
          nodeId: node.id,
          name: node.name,
          type: 'COMPONENT_SET',
          description: node.description || null,
          variantAxes: axes,
          variants: variants,
          defaultVariant: variants.length > 0 ? variants[0] : null,
          properties: setPropDefs ? Object.keys(setPropDefs).map(function(propName) {
            var propDef = setPropDefs[propName];
            return {
              name: propName,
              type: propDef.type,
              defaultValue: propDef.defaultValue
            };
          }) : [],
          slots: extractSlots(node)
        };
      }

      // Load all pages first (required before accessing children)
      console.log('🌉 [Desktop Bridge] Loading all pages...');
      await figma.loadAllPagesAsync();

      // Native search instead of a JS walk over every node (#120): the walk
      // crossed into the Plugin API for each of the file's nodes, including
      // every layer inside every instance (89k nodes: 1.7s vs 0.13s here, and
      // far worse on heavier files).
      var found = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] });
      console.log('🌉 [Desktop Bridge] Found ' + found.length + ' component nodes; extracting...');
      for (var fi = 0; fi < found.length; fi++) {
        var fnode = found[fi];
        try {
          if (fnode.type === 'COMPONENT_SET') {
            componentSets.push(extractComponentSetData(fnode));
          } else if (!fnode.parent || fnode.parent.type !== 'COMPONENT_SET') {
            // Standalone components only (variants are reported under their set)
            components.push(extractComponentData(fnode, false));
          }
        } catch (e) { /* unresolvable slot sublayer — skip */ }
        // No setTimeout yields here: plugin timers are throttled when Figma is
        // in the background (up to ~1/min under Chromium's intensive
        // throttling), so a handful of yields turned a ~1.5s extraction into
        // the 300s timeout reported in #120.
      }

      console.log('🌉 [Desktop Bridge] Found ' + components.length + ' components and ' + componentSets.length + ' component sets');

      figma.ui.postMessage({
        type: 'GET_LOCAL_COMPONENTS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          components: components,
          componentSets: componentSets,
          totalComponents: components.length,
          totalComponentSets: componentSets.length,
          // Include file metadata for context verification
          fileName: figma.root.name,
          fileKey: figma.fileKey || null,
          timestamp: Date.now()
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Get local components error:', errorMsg);
      figma.ui.postMessage({
        type: 'GET_LOCAL_COMPONENTS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // INSTANTIATE_COMPONENT - Create a component instance with overrides
  // ============================================================================
  else if (msg.type === 'INSTANTIATE_COMPONENT') {
    try {
      console.log('🌉 [Desktop Bridge] Instantiating component:', msg.componentKey || msg.nodeId);

      var component = null;
      var instance = null;

      // Try published library first (by key), then fall back to local component (by nodeId)
      if (msg.componentKey) {
        // Try importComponentByKeyAsync first (for COMPONENT nodes)
        try {
          var importResult = await Promise.race([
            figma.importComponentByKeyAsync(msg.componentKey),
            new Promise(function(_, reject) {
              setTimeout(function() { reject(new Error('Import timed out after 15s — component may not be published to a team library')); }, 15000);
            })
          ]);
          component = importResult;
        } catch (importError) {
          var importErrMsg = importError && importError.message ? importError.message : String(importError);
          console.log('🌉 [Desktop Bridge] importComponentByKeyAsync failed: ' + importErrMsg);
        }

        // If that failed, try importComponentSetByKeyAsync (for COMPONENT_SET nodes)
        if (!component) {
          try {
            var setResult = await Promise.race([
              figma.importComponentSetByKeyAsync(msg.componentKey),
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error('ComponentSet import timed out after 15s')); }, 15000);
              })
            ]);
            // Got the component set — use its default variant (first child)
            if (setResult && setResult.type === 'COMPONENT_SET') {
              console.log('🌉 [Desktop Bridge] Imported component set "' + setResult.name + '" with ' + setResult.children.length + ' variants');
              component = setResult.defaultVariant || setResult.children[0];
            }
          } catch (setError) {
            var setErrMsg = setError && setError.message ? setError.message : String(setError);
            console.log('🌉 [Desktop Bridge] importComponentSetByKeyAsync also failed: ' + setErrMsg + ', trying local...');
          }
        }
      }

      // Fall back to local component by nodeId
      if (!component && msg.nodeId) {
        var node = await figma.getNodeByIdAsync(msg.nodeId);
        if (node) {
          if (node.type === 'COMPONENT') {
            component = node;
          } else if (node.type === 'COMPONENT_SET') {
            // For component sets, find the right variant or use default
            if (msg.variant && node.children && node.children.length > 0) {
              // Build variant name from properties (e.g., "Type=Simple, State=Default")
              var variantParts = [];
              for (var prop in msg.variant) {
                if (msg.variant.hasOwnProperty(prop)) {
                  variantParts.push(prop + '=' + msg.variant[prop]);
                }
              }
              var targetVariantName = variantParts.join(', ');
              console.log('🌉 [Desktop Bridge] Looking for variant:', targetVariantName);

              // Find matching variant
              for (var i = 0; i < node.children.length; i++) {
                var child = node.children[i];
                if (child.type === 'COMPONENT' && child.name === targetVariantName) {
                  component = child;
                  console.log('🌉 [Desktop Bridge] Found exact variant match');
                  break;
                }
              }

              // If no exact match, try partial match
              if (!component) {
                for (var i = 0; i < node.children.length; i++) {
                  var child = node.children[i];
                  if (child.type === 'COMPONENT') {
                    var matches = true;
                    for (var prop in msg.variant) {
                      if (msg.variant.hasOwnProperty(prop)) {
                        var expected = prop + '=' + msg.variant[prop];
                        if (child.name.indexOf(expected) === -1) {
                          matches = false;
                          break;
                        }
                      }
                    }
                    if (matches) {
                      component = child;
                      console.log('🌉 [Desktop Bridge] Found partial variant match:', child.name);
                      break;
                    }
                  }
                }
              }
            }

            // Default to first variant if no match
            if (!component && node.children && node.children.length > 0) {
              component = node.children[0];
              console.log('🌉 [Desktop Bridge] Using default variant:', component.name);
            }
          }
        }
      }

      if (!component) {
        // Build detailed error message with actionable guidance
        var errorParts = ['Component not found.'];

        if (msg.componentKey && !msg.nodeId) {
          errorParts.push('Component key "' + msg.componentKey + '" not found. Note: componentKey only works for components from published libraries. For local/unpublished components, you must provide nodeId instead.');
        } else if (msg.componentKey && msg.nodeId) {
          errorParts.push('Neither componentKey "' + msg.componentKey + '" nor nodeId "' + msg.nodeId + '" resolved to a valid component. The identifiers may be stale from a previous session.');
        } else if (msg.nodeId) {
          errorParts.push('NodeId "' + msg.nodeId + '" does not exist in this file. NodeIds are session-specific and become stale when Figma restarts or the file is closed.');
        } else {
          errorParts.push('No componentKey or nodeId was provided.');
        }

        errorParts.push('SOLUTION: Call figma_search_components to get fresh identifiers, then pass BOTH componentKey AND nodeId together for reliable instantiation.');

        throw new Error(errorParts.join(' '));
      }

      // Create the instance
      instance = component.createInstance();

      // Apply position if specified
      if (msg.position) {
        instance.x = msg.position.x || 0;
        instance.y = msg.position.y || 0;
      }

      // Apply size override if specified
      if (msg.size) {
        instance.resize(msg.size.width, msg.size.height);
      }

      // Pre-load fonts for the instance's text nodes BEFORE applying overrides.
      // Text-property overrides mutate text content, which throws in dynamic-page
      // mode unless the font is already loaded. Loading once up front also avoids
      // the per-node timeouts seen when fonts are loaded inside a loop.
      await loadFontsForNode(instance);

      // Track failures so they surface in the result instead of failing silently.
      var overrideWarnings = [];

      // Apply property overrides. Property keys on the instance carry #nodeId
      // suffixes ("title#2605:17"), so resolve the caller's bare name first —
      // otherwise setProperties throws "Could not find a component property".
      if (msg.overrides) {
        var instanceProps = {};
        try { instanceProps = instance.componentProperties || {}; } catch (e) { instanceProps = {}; }
        for (var propName in msg.overrides) {
          if (msg.overrides.hasOwnProperty(propName)) {
            var resolvedName = resolvePropertyName(instanceProps, propName);
            try {
              var propsObj = {};
              propsObj[resolvedName || propName] = msg.overrides[propName];
              instance.setProperties(propsObj);
            } catch (propError) {
              var pMsg = propError && propError.message ? propError.message : String(propError);
              console.warn('🌉 [Desktop Bridge] Could not set property ' + propName + ':', pMsg);
              overrideWarnings.push('override "' + propName + '" failed: ' + pMsg);
            }
          }
        }
      }

      // Apply variant selection if specified
      if (msg.variant) {
        try {
          instance.setProperties(msg.variant);
        } catch (variantError) {
          var vMsg = variantError && variantError.message ? variantError.message : String(variantError);
          console.warn('🌉 [Desktop Bridge] Could not set variant:', vMsg);
          overrideWarnings.push('variant selection failed: ' + vMsg);
        }
      }

      // Append to parent if specified
      if (msg.parentId) {
        var parent = await figma.getNodeByIdAsync(msg.parentId);
        if (parent && 'appendChild' in parent) {
          parent.appendChild(instance);
        } else {
          overrideWarnings.push('parentId "' + msg.parentId + '" not found or cannot accept children; instance placed on current page');
        }
      }

      console.log('🌉 [Desktop Bridge] Component instantiated:', instance.id);

      figma.ui.postMessage({
        type: 'INSTANTIATE_COMPONENT_RESULT',
        requestId: msg.requestId,
        success: true,
        instance: {
          id: instance.id,
          name: instance.name,
          x: instance.x,
          y: instance.y,
          width: instance.width,
          height: instance.height
        },
        warnings: overrideWarnings.length ? overrideWarnings : undefined
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Instantiate component error:', errorMsg);
      figma.ui.postMessage({
        type: 'INSTANTIATE_COMPONENT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // CREATE_COMPONENT_SET - Build a component set with variants in one call
  // Two modes:
  //   A) baseComponentId + properties: clone the base for every combination of
  //      the property axes ({State:[default,hover], Size:[sm,lg]} → 4 variants),
  //      rename each to "Prop=Value, Prop=Value", combineAsVariants.
  //      The base component itself BECOMES the first variant (same node ID),
  //      so existing instances of the base survive as instances of that variant.
  //   B) componentIds (+ optional variantProperties): combine existing local
  //      COMPONENT nodes as variants, optionally renaming them first.
  // Variant properties are derived by Figma from the "Prop=Value" names, and
  // componentPropertyDefinitions live on the resulting SET (not the variants).
  // No text is written here, so no font loading is needed (clone() copies text
  // without touching characters).
  // ============================================================================
  else if (msg.type === 'CREATE_COMPONENT_SET') {
    try {
      console.log('🌉 [Desktop Bridge] Creating component set:', msg.name || msg.baseComponentId || (msg.componentIds && msg.componentIds.length + ' components'));

      var MAX_VARIANTS = 100;
      var setWarnings = [];
      // Rollback state — if anything throws before combineAsVariants succeeds,
      // remove Mode A clones, restore the base's name, AND restore every
      // Mode B component the handler renamed, so no partial artifacts remain.
      // (Previously only Mode A was rolled back: a throw from the
      // duplicate-combo check or combineAsVariants left the user's standalone
      // components permanently renamed with no set created.)
      var createdClones = [];
      var renamedBase = null;
      var originalBaseName = null;
      var renamedNodes = []; // Mode B: [{ node, originalName }]
      var combineDone = false;

      function rollbackComponentSetWork() {
        for (var rc = 0; rc < createdClones.length; rc++) {
          try { createdClones[rc].remove(); } catch (e) {}
        }
        createdClones = [];
        if (renamedBase && originalBaseName !== null) {
          try { renamedBase.name = originalBaseName; } catch (e) {}
          renamedBase = null;
        }
        for (var rn = 0; rn < renamedNodes.length; rn++) {
          try { renamedNodes[rn].node.name = renamedNodes[rn].originalName; } catch (e) {}
        }
        renamedNodes = [];
      }

      // Build "Prop=Value, Prop=Value" from an axis-ordered property map
      function comboName(combo, axisOrder) {
        var parts = [];
        for (var a = 0; a < axisOrder.length; a++) {
          parts.push(axisOrder[a] + '=' + combo[axisOrder[a]]);
        }
        return parts.join(', ');
      }

      var variantNodes = [];

      if (msg.baseComponentId) {
        // ---- Mode A: generate variants from a base component ----
        if (!msg.properties || Object.keys(msg.properties).length === 0) {
          throw new Error('properties is required with baseComponentId. Example: { "State": ["default", "hover"], "Size": ["sm", "lg"] }');
        }

        var base = await figma.getNodeByIdAsync(msg.baseComponentId);
        if (!base) throw new Error('Base component not found: ' + msg.baseComponentId + '. NodeIds are session-specific — re-search components to get fresh IDs.');
        if (base.type !== 'COMPONENT') {
          throw new Error('baseComponentId must be a COMPONENT node, got ' + base.type + '. To convert a frame, use figma_execute with figma.createComponentFromNode(frame) first.');
        }
        if (base.parent && base.parent.type === 'COMPONENT_SET') {
          throw new Error('Base component is already a variant inside component set "' + base.parent.name + '". Use a standalone component.');
        }

        // Validate axes and build the cartesian product (last axis varies fastest,
        // matching Figma's convention of State as the final property)
        var axisOrder = [];
        var axisValues = {};
        for (var axis in msg.properties) {
          if (msg.properties.hasOwnProperty(axis)) {
            var vals = msg.properties[axis];
            if (!vals || !vals.length) throw new Error('Property axis "' + axis + '" has no values');
            var uniq = {};
            for (var vv = 0; vv < vals.length; vv++) {
              var sval = String(vals[vv]);
              if (sval.indexOf('=') !== -1 || sval.indexOf(',') !== -1) {
                throw new Error('Variant value "' + sval + '" (axis "' + axis + '") must not contain "=" or "," — Figma parses variant names on those characters');
              }
              if (uniq[sval]) throw new Error('Duplicate value "' + sval + '" in axis "' + axis + '"');
              uniq[sval] = true;
            }
            if (axis.indexOf('=') !== -1 || axis.indexOf(',') !== -1) {
              throw new Error('Property name "' + axis + '" must not contain "=" or ","');
            }
            axisOrder.push(axis);
            axisValues[axis] = vals.map(String);
          }
        }

        var combos = [{}];
        for (var ai = 0; ai < axisOrder.length; ai++) {
          var nextCombos = [];
          var axisName = axisOrder[ai];
          for (var ci = 0; ci < combos.length; ci++) {
            for (var vi2 = 0; vi2 < axisValues[axisName].length; vi2++) {
              var extended = {};
              for (var k in combos[ci]) { if (combos[ci].hasOwnProperty(k)) extended[k] = combos[ci][k]; }
              extended[axisName] = axisValues[axisName][vi2];
              nextCombos.push(extended);
            }
          }
          combos = nextCombos;
        }

        if (combos.length > MAX_VARIANTS) {
          throw new Error('Requested ' + combos.length + ' variants — capped at ' + MAX_VARIANTS + '. Split into multiple sets or reduce axis values.');
        }

        // Base becomes the first combination; clones fill in the rest.
        // Stack clones vertically so nothing overlaps even without autoArrange.
        var baseX = base.x;
        var baseY = base.y;
        var stepY = Math.ceil(base.height) + 40;
        originalBaseName = base.name;
        renamedBase = base;
        base.name = comboName(combos[0], axisOrder);
        variantNodes.push(base);
        for (var ci2 = 1; ci2 < combos.length; ci2++) {
          var clone = base.clone();
          clone.name = comboName(combos[ci2], axisOrder);
          clone.x = baseX;
          clone.y = baseY + ci2 * stepY;
          createdClones.push(clone);
          variantNodes.push(clone);
        }
      } else if (msg.componentIds && msg.componentIds.length) {
        // ---- Mode B: combine existing components ----
        if (msg.componentIds.length > MAX_VARIANTS) {
          throw new Error('Requested ' + msg.componentIds.length + ' variants — capped at ' + MAX_VARIANTS + '.');
        }
        if (msg.variantProperties && msg.variantProperties.length !== msg.componentIds.length) {
          throw new Error('variantProperties length (' + msg.variantProperties.length + ') must match componentIds length (' + msg.componentIds.length + ')');
        }

        for (var ni = 0; ni < msg.componentIds.length; ni++) {
          var node = await figma.getNodeByIdAsync(msg.componentIds[ni]);
          if (!node) throw new Error('Component not found: ' + msg.componentIds[ni] + '. NodeIds are session-specific — re-search components to get fresh IDs.');
          if (node.type !== 'COMPONENT') {
            throw new Error('Node ' + msg.componentIds[ni] + ' is a ' + node.type + ', not a COMPONENT. All componentIds must reference COMPONENT nodes.');
          }
          if (node.parent && node.parent.type === 'COMPONENT_SET') {
            throw new Error('Component "' + node.name + '" (' + node.id + ') is already a variant in set "' + node.parent.name + '". Components can only belong to one set.');
          }
          if (msg.variantProperties) {
            var props = msg.variantProperties[ni];
            var propKeys = Object.keys(props);
            if (!propKeys.length) throw new Error('variantProperties[' + ni + '] is empty — each entry needs at least one property (e.g. { "State": "hover" })');
            // Same '='/',' validation as Mode A — a value like "hover,Size=lg"
            // would silently create a bogus axis when Figma parses the name.
            for (var pk = 0; pk < propKeys.length; pk++) {
              var propName = propKeys[pk];
              var propValue = String(props[propName]);
              if (propName.indexOf('=') !== -1 || propName.indexOf(',') !== -1) {
                throw new Error('Property name "' + propName + '" (variantProperties[' + ni + ']) must not contain "=" or "," — Figma parses variant names on those characters');
              }
              if (propValue.indexOf('=') !== -1 || propValue.indexOf(',') !== -1) {
                throw new Error('Variant value "' + propValue + '" (property "' + propName + '", variantProperties[' + ni + ']) must not contain "=" or "," — Figma parses variant names on those characters');
              }
            }
            // Record the rename so the rollback path can restore it.
            renamedNodes.push({ node: node, originalName: node.name });
            variantNodes.push(node);
            node.name = comboName(props, propKeys);
          } else {
            variantNodes.push(node);
            if (node.name.indexOf('=') === -1) {
              setWarnings.push('Component "' + node.name + '" is not named "Prop=Value" — Figma will file it under "Property 1=' + node.name + '". Pass variantProperties to control naming.');
            }
          }
        }

        // Duplicate variant names create an invalid (conflicting) set — fail early
        var nameSeen = {};
        for (var dn = 0; dn < variantNodes.length; dn++) {
          if (nameSeen[variantNodes[dn].name]) {
            throw new Error('Two variants would have identical properties: "' + variantNodes[dn].name + '". Each variant needs a unique property combination.');
          }
          nameSeen[variantNodes[dn].name] = true;
        }
      } else {
        throw new Error('Provide either baseComponentId + properties (generate variants) or componentIds (combine existing components).');
      }

      // Resolve the parent — combineAsVariants REQUIRES a parent, and the set is
      // created inside it. Fall back to the current page.
      var setParent = figma.currentPage;
      if (msg.parentId) {
        var requestedParent = await figma.getNodeByIdAsync(msg.parentId);
        if (requestedParent && typeof requestedParent.appendChild === 'function' && requestedParent.type !== 'COMPONENT' && requestedParent.type !== 'COMPONENT_SET' && requestedParent.type !== 'INSTANCE') {
          setParent = requestedParent;
        } else {
          setWarnings.push('parentId "' + msg.parentId + '" not found or cannot contain a component set; created on the current page instead');
        }
      }

      // Housekeeping on failure happens in the outer catch (gated on
      // !combineDone) — it restores Mode A clones/base AND Mode B renames.
      var componentSet = figma.combineAsVariants(variantNodes, setParent);
      combineDone = true;
      if (msg.name) componentSet.name = msg.name;
      if (msg.position) {
        componentSet.x = msg.position.x || 0;
        componentSet.y = msg.position.y || 0;
      }

      // componentPropertyDefinitions live on the SET (not the variants) —
      // read them back so callers see the axes Figma actually derived.
      var propertyDefinitions = {};
      try {
        var defs = componentSet.componentPropertyDefinitions;
        for (var defName in defs) {
          if (defs.hasOwnProperty(defName)) {
            propertyDefinitions[defName] = {
              type: defs[defName].type,
              defaultValue: defs[defName].defaultValue,
              variantOptions: defs[defName].variantOptions || []
            };
          }
        }
      } catch (defError) {
        setWarnings.push('Could not read componentPropertyDefinitions: ' + (defError && defError.message ? defError.message : String(defError)));
      }

      var variantSummaries = [];
      for (var vs = 0; vs < componentSet.children.length; vs++) {
        var child = componentSet.children[vs];
        if (child.type === 'COMPONENT') {
          // Include each variant's key — instantiation uses VARIANT keys, not the set key
          variantSummaries.push({ id: child.id, name: child.name, key: child.key });
        }
      }

      figma.currentPage.selection = [componentSet];
      figma.viewport.scrollAndZoomIntoView([componentSet]);

      console.log('🌉 [Desktop Bridge] Component set created:', componentSet.id, 'with', variantSummaries.length, 'variants');

      // Everything rides in `data` — ui.html's handleResult only forwards
      // whitelisted top-level fields, and msg.data is on that whitelist.
      figma.ui.postMessage({
        type: 'CREATE_COMPONENT_SET_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          componentSet: {
            id: componentSet.id,
            name: componentSet.name,
            key: componentSet.key,
            x: componentSet.x,
            y: componentSet.y,
            width: componentSet.width,
            height: componentSet.height,
            parentId: componentSet.parent ? componentSet.parent.id : null
          },
          variantCount: variantSummaries.length,
          variants: variantSummaries,
          propertyDefinitions: propertyDefinitions,
          warnings: setWarnings.length ? setWarnings : undefined
        }
      });

    } catch (error) {
      var csErrorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Create component set error:', csErrorMsg);
      // Undo partial work unless the set was actually created (after
      // combineAsVariants succeeds the clones/renames live inside the set —
      // never touch them then).
      try { if (!combineDone) rollbackComponentSetWork(); } catch (e) {}
      figma.ui.postMessage({
        type: 'CREATE_COMPONENT_SET_RESULT',
        requestId: msg.requestId,
        success: false,
        error: csErrorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_DESCRIPTION - Set description on component/style
  // ============================================================================
  else if (msg.type === 'SET_NODE_DESCRIPTION') {
    try {
      console.log('🌉 [Desktop Bridge] Setting description on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      // Check if node supports description
      if (!('description' in node)) {
        throw new Error('Node type ' + node.type + ' does not support description');
      }

      // Set description (and markdown if supported)
      node.description = msg.description || '';
      if (msg.descriptionMarkdown && 'descriptionMarkdown' in node) {
        node.descriptionMarkdown = msg.descriptionMarkdown;
      }

      console.log('🌉 [Desktop Bridge] Description set successfully');

      figma.ui.postMessage({
        type: 'SET_NODE_DESCRIPTION_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, description: node.description }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set description error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_DESCRIPTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // GET_ANNOTATIONS - Read annotations from a node (and optionally children)
  // ============================================================================
  else if (msg.type === 'GET_ANNOTATIONS') {
    try {
      console.log('🌉 [Desktop Bridge] Getting annotations for node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      // Get annotation categories for name resolution
      var categories = [];
      try {
        categories = await figma.annotations.getAnnotationCategoriesAsync();
      } catch (e) {
        console.log('🌉 [Desktop Bridge] Could not fetch annotation categories:', e.message);
      }

      // Build category lookup map
      var categoryMap = {};
      for (var ci = 0; ci < categories.length; ci++) {
        categoryMap[categories[ci].id] = categories[ci].name;
      }

      // Helper to extract annotations from a single node
      function extractAnnotations(n) {
        var anns = n.annotations || [];
        var result = [];
        for (var ai = 0; ai < anns.length; ai++) {
          var ann = anns[ai];
          var props = [];
          if (ann.properties) {
            for (var pi = 0; pi < ann.properties.length; pi++) {
              props.push({ type: ann.properties[pi].type });
            }
          }
          result.push({
            label: ann.label || null,
            labelMarkdown: ann.labelMarkdown || null,
            properties: props.length > 0 ? props : null,
            categoryId: ann.categoryId || null,
            categoryName: ann.categoryId && categoryMap[ann.categoryId] ? categoryMap[ann.categoryId] : null
          });
        }
        return result;
      }

      // Collect annotations from the node itself
      var nodeAnnotations = extractAnnotations(node);
      var childAnnotations = [];

      // Optionally walk children
      var includeChildren = msg.includeChildren || false;
      var maxDepth = msg.depth || 1;

      if (includeChildren && 'children' in node && node.children) {
        function walkChildren(parent, currentDepth) {
          if (currentDepth > maxDepth) return;
          for (var i = 0; i < parent.children.length; i++) {
            var child = parent.children[i];
            try {
              var anns = extractAnnotations(child);
              if (anns.length > 0) {
                childAnnotations.push({
                  nodeId: child.id,
                  nodeName: child.name,
                  nodeType: child.type,
                  annotations: anns
                });
              }
              if ('children' in child && child.children) {
                walkChildren(child, currentDepth + 1);
              }
            } catch (e) {
              // Skip inaccessible children (slot sublayers, etc.)
            }
          }
        }
        walkChildren(node, 1);
      }

      var result = {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        annotations: nodeAnnotations,
        annotationCount: nodeAnnotations.length,
        children: includeChildren ? childAnnotations : undefined,
        childAnnotationCount: includeChildren ? childAnnotations.reduce(function(sum, c) { return sum + c.annotations.length; }, 0) : undefined,
        availableCategories: categories.map(function(c) { return { id: c.id, name: c.name }; })
      };

      console.log('🌉 [Desktop Bridge] Annotations retrieved. Node: ' + nodeAnnotations.length + ', Children: ' + (childAnnotations.length || 0));

      figma.ui.postMessage({
        type: 'GET_ANNOTATIONS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: result
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Get annotations error:', errorMsg);
      figma.ui.postMessage({
        type: 'GET_ANNOTATIONS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_ANNOTATIONS - Write annotations to a node
  // ============================================================================
  else if (msg.type === 'SET_ANNOTATIONS') {
    try {
      console.log('🌉 [Desktop Bridge] Setting annotations on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      // Verify node supports annotations
      if (!('annotations' in node)) {
        throw new Error('Node type ' + node.type + ' does not support annotations');
      }

      // Build the annotations array
      var newAnnotations = [];
      var inputAnnotations = msg.annotations || [];

      for (var i = 0; i < inputAnnotations.length; i++) {
        var input = inputAnnotations[i];
        var ann = {};

        if (input.label) {
          ann.label = input.label;
        }
        if (input.labelMarkdown) {
          ann.labelMarkdown = input.labelMarkdown;
        }
        if (input.properties && input.properties.length > 0) {
          ann.properties = [];
          for (var p = 0; p < input.properties.length; p++) {
            ann.properties.push({ type: input.properties[p].type });
          }
        }
        if (input.categoryId) {
          ann.categoryId = input.categoryId;
        }

        newAnnotations.push(ann);
      }

      // Optionally append to existing annotations instead of replacing
      if (msg.mode === 'append') {
        var existing = node.annotations || [];
        var merged = [];
        for (var e = 0; e < existing.length; e++) {
          var ex = existing[e];
          var copy = {};
          // Figma auto-populates both label and labelMarkdown on read,
          // but rejects writing both — prefer labelMarkdown when both exist
          if (ex.labelMarkdown) {
            copy.labelMarkdown = ex.labelMarkdown;
          } else if (ex.label) {
            copy.label = ex.label;
          }
          if (ex.properties) copy.properties = ex.properties;
          if (ex.categoryId) copy.categoryId = ex.categoryId;
          merged.push(copy);
        }
        for (var n = 0; n < newAnnotations.length; n++) {
          merged.push(newAnnotations[n]);
        }
        newAnnotations = merged;
      }

      // Set annotations on the node
      node.annotations = newAnnotations;

      console.log('🌉 [Desktop Bridge] Annotations set successfully. Count: ' + newAnnotations.length);

      figma.ui.postMessage({
        type: 'SET_ANNOTATIONS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          nodeId: node.id,
          nodeName: node.name,
          annotationCount: newAnnotations.length,
          mode: msg.mode || 'replace'
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set annotations error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_ANNOTATIONS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // GET_ANNOTATION_CATEGORIES - List available annotation categories
  // ============================================================================
  else if (msg.type === 'GET_ANNOTATION_CATEGORIES') {
    try {
      console.log('🌉 [Desktop Bridge] Fetching annotation categories');

      var categories = await figma.annotations.getAnnotationCategoriesAsync();
      var result = categories.map(function(c) { return { id: c.id, name: c.name }; });

      console.log('🌉 [Desktop Bridge] Found ' + result.length + ' annotation categories');

      figma.ui.postMessage({
        type: 'GET_ANNOTATION_CATEGORIES_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { categories: result }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Get annotation categories error:', errorMsg);
      figma.ui.postMessage({
        type: 'GET_ANNOTATION_CATEGORIES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // ADD_COMPONENT_PROPERTY - Add property to component
  // ============================================================================
  else if (msg.type === 'ADD_COMPONENT_PROPERTY') {
    try {
      console.log('🌉 [Desktop Bridge] Adding component property:', msg.propertyName, 'type:', msg.propertyType);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
        throw new Error('Node must be a COMPONENT or COMPONENT_SET. Got: ' + node.type);
      }

      // Check if it's a variant (can't add properties to variants)
      if (node.type === 'COMPONENT' && node.parent && node.parent.type === 'COMPONENT_SET') {
        throw new Error('Cannot add properties to variant components. Add to the parent COMPONENT_SET instead.');
      }

      // Build options if preferredValues and/or description provided (SLOT supports both)
      var options = undefined;
      if (msg.preferredValues || msg.description) {
        options = {};
        if (msg.preferredValues) options.preferredValues = msg.preferredValues;
        if (msg.description) options.description = msg.description;
      }

      // SLOT properties do not support defaultValue — pass empty string.
      // VARIANT properties REQUIRE a non-empty defaultValue (live-validated
      // 2026-07-09: '' throws "Component property default value cannot be
      // empty") — pass the caller's value through untouched.
      var defaultValue = msg.defaultValue;
      if (msg.propertyType === 'SLOT') {
        defaultValue = '';
      }

      // Use msg.propertyType (not msg.type which is the message type 'ADD_COMPONENT_PROPERTY')
      var propertyNameWithId = node.addComponentProperty(msg.propertyName, msg.propertyType, defaultValue, options);

      console.log('🌉 [Desktop Bridge] Property added:', propertyNameWithId);

      figma.ui.postMessage({
        type: 'ADD_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: true,
        propertyName: propertyNameWithId
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Add component property error:', errorMsg);
      figma.ui.postMessage({
        type: 'ADD_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // EDIT_COMPONENT_PROPERTY - Edit existing component property
  // ============================================================================
  else if (msg.type === 'EDIT_COMPONENT_PROPERTY') {
    try {
      console.log('🌉 [Desktop Bridge] Editing component property:', msg.propertyName);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
        throw new Error('Node must be a COMPONENT or COMPONENT_SET. Got: ' + node.type);
      }

      var propertyNameWithId = node.editComponentProperty(msg.propertyName, msg.newValue);

      console.log('🌉 [Desktop Bridge] Property edited:', propertyNameWithId);

      figma.ui.postMessage({
        type: 'EDIT_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: true,
        propertyName: propertyNameWithId
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Edit component property error:', errorMsg);
      figma.ui.postMessage({
        type: 'EDIT_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // DELETE_COMPONENT_PROPERTY - Delete a component property
  // ============================================================================
  else if (msg.type === 'DELETE_COMPONENT_PROPERTY') {
    try {
      console.log('🌉 [Desktop Bridge] Deleting component property:', msg.propertyName);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
        throw new Error('Node must be a COMPONENT or COMPONENT_SET. Got: ' + node.type);
      }

      node.deleteComponentProperty(msg.propertyName);

      console.log('🌉 [Desktop Bridge] Property deleted');

      figma.ui.postMessage({
        type: 'DELETE_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: true
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Delete component property error:', errorMsg);
      figma.ui.postMessage({
        type: 'DELETE_COMPONENT_PROPERTY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SLOT OPERATIONS — Figma Slots open beta (SlotNode API)
  // ============================================================================

  // CREATE_SLOT — create a SlotNode inside a component via createSlot()
  else if (msg.type === 'CREATE_SLOT') {
    try {
      console.log('🌉 [Desktop Bridge] Creating slot on component:', msg.nodeId);

      var componentNode = await figma.getNodeByIdAsync(msg.nodeId);
      if (!componentNode) {
        throw new Error('Node not found: ' + msg.nodeId);
      }
      if (componentNode.type !== 'COMPONENT') {
        throw new Error('Node must be a COMPONENT (standalone or a variant inside a COMPONENT_SET). Got: ' + componentNode.type + '. For a COMPONENT_SET, call this once per variant component.');
      }
      if (typeof componentNode.createSlot !== 'function') {
        throw new Error('createSlot() is not available. Update Figma Desktop to a version with Slots support.');
      }

      // createSlot() takes no arguments (a name arg is ignored — live-validated
      // 2026-07-09). Renaming the returned node renames the linked SLOT property
      // key live (Slot#id → Name#id), so rename-after-create IS the naming API.
      var newSlot = componentNode.createSlot();
      if (msg.name) newSlot.name = msg.name;
      if (msg.layoutMode && msg.layoutMode !== 'GRID') {
        newSlot.layoutMode = msg.layoutMode;
      } else if (msg.layoutMode === 'GRID') {
        throw new Error('GRID layoutMode is not allowed on slot nodes');
      }
      if (msg.width !== undefined || msg.height !== undefined) {
        newSlot.resize(
          msg.width !== undefined ? msg.width : newSlot.width,
          msg.height !== undefined ? msg.height : newSlot.height
        );
      }

      var slotPropertyKey = null;
      try {
        if (newSlot.componentPropertyReferences && newSlot.componentPropertyReferences.slotContentId) {
          slotPropertyKey = newSlot.componentPropertyReferences.slotContentId;
        }
      } catch (e) { /* ignore */ }

      figma.ui.postMessage({
        type: 'CREATE_SLOT_RESULT',
        requestId: msg.requestId,
        success: true,
        slot: {
          id: newSlot.id,
          name: newSlot.name,
          type: newSlot.type,
          propertyKey: slotPropertyKey,
          width: newSlot.width,
          height: newSlot.height,
          layoutMode: newSlot.layoutMode
        }
      });
    } catch (error) {
      var createSlotError = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Create slot error:', createSlotError);
      figma.ui.postMessage({
        type: 'CREATE_SLOT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: createSlotError
      });
    }
  }

  // GET_SLOTS — list SlotNode children on a component or instance
  else if (msg.type === 'GET_SLOTS') {
    try {
      console.log('🌉 [Desktop Bridge] Getting slots for node:', msg.nodeId);

      var targetNode = await figma.getNodeByIdAsync(msg.nodeId);
      if (!targetNode) {
        throw new Error('Node not found: ' + msg.nodeId);
      }
      if (targetNode.type !== 'COMPONENT' && targetNode.type !== 'INSTANCE' && targetNode.type !== 'COMPONENT_SET') {
        throw new Error('Node must be a COMPONENT, COMPONENT_SET, or INSTANCE. Got: ' + targetNode.type);
      }

      var slotsResult = [];
      if (targetNode.type === 'COMPONENT_SET') {
        // Aggregate slots from all variant components
        for (var vi = 0; vi < targetNode.children.length; vi++) {
          var variant = targetNode.children[vi];
          if (variant.type !== 'COMPONENT') continue;
          var variantSlots = serializeSlotsFromNode(variant);
          for (var vsi = 0; vsi < variantSlots.length; vsi++) {
            variantSlots[vsi].variantId = variant.id;
            variantSlots[vsi].variantName = variant.name;
          }
          slotsResult = slotsResult.concat(variantSlots);
        }
      } else {
        slotsResult = serializeSlotsFromNode(targetNode);
      }

      figma.ui.postMessage({
        type: 'GET_SLOTS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          nodeId: targetNode.id,
          nodeType: targetNode.type,
          slots: slotsResult,
          count: slotsResult.length
        }
      });
    } catch (error) {
      var getSlotsError = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Get slots error:', getSlotsError);
      figma.ui.postMessage({
        type: 'GET_SLOTS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: getSlotsError
      });
    }
  }

  // APPEND_TO_SLOT — clone or move a node into a slot (instances only for content population)
  else if (msg.type === 'APPEND_TO_SLOT') {
    try {
      console.log('🌉 [Desktop Bridge] Appending to slot');

      var slotNode = await resolveSlotNode(msg);
      var slotParent = slotNode.parent;
      if (!slotParent) {
        throw new Error('Slot has no parent');
      }

      // Prepare the content FIRST — validation failures must not leave the
      // slot half-mutated (clearExisting used to run before source resolution,
      // so a bad sourceNodeId emptied the slot and then errored).
      var appendedNode;
      if (msg.sourceNodeId) {
        var sourceNode = await figma.getNodeByIdAsync(msg.sourceNodeId);
        if (!sourceNode) {
          throw new Error('Source node not found: ' + msg.sourceNodeId);
        }
        // Guard BEFORE cloning — a clone of a ComponentNode is itself a
        // ComponentNode, and cloning first leaks an orphan main component.
        if (sourceNode.type === 'COMPONENT') {
          throw new Error('ComponentNodes cannot be appended directly to a slot. Create an instance with createInstance() or clone an existing instance instead.');
        }
        if (msg.clone !== false) {
          appendedNode = sourceNode.clone();
        } else {
          appendedNode = sourceNode;
        }
      } else if (msg.nodeType) {
        var slotProps = msg.properties || {};
        switch (msg.nodeType) {
          case 'RECTANGLE':
            appendedNode = figma.createRectangle();
            break;
          case 'ELLIPSE':
            appendedNode = figma.createEllipse();
            break;
          case 'FRAME':
            appendedNode = figma.createFrame();
            break;
          case 'TEXT':
            appendedNode = figma.createText();
            await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
            appendedNode.fontName = { family: 'Inter', style: 'Regular' };
            // Coerce: schema allows string|number; characters requires string.
            // Check !== undefined so 0 and "0" are honored.
            if (slotProps.text !== undefined) appendedNode.characters = String(slotProps.text);
            break;
          case 'LINE':
            appendedNode = figma.createLine();
            break;
          case 'POLYGON':
            appendedNode = figma.createPolygon();
            break;
          case 'STAR':
            appendedNode = figma.createStar();
            break;
          case 'VECTOR':
            appendedNode = figma.createVector();
            break;
          default:
            throw new Error('Unsupported node type for slot content: ' + msg.nodeType);
        }
        if (slotProps.name) appendedNode.name = String(slotProps.name);
        // Coerce to numbers and allow width-only / height-only resizes.
        if (slotProps.width !== undefined || slotProps.height !== undefined) {
          var rw = slotProps.width !== undefined ? Number(slotProps.width) : appendedNode.width;
          var rh = slotProps.height !== undefined ? Number(slotProps.height) : appendedNode.height;
          if (!isNaN(rw) && !isNaN(rh)) appendedNode.resize(rw, rh);
        }
      } else {
        throw new Error('Provide sourceNodeId (to clone/move into slot) or nodeType (to create new content in slot)');
      }

      // Content is ready — NOW it is safe to clear existing children.
      if (msg.clearExisting) {
        var existingChildren = [];
        try {
          for (var ei = 0; ei < slotNode.children.length; ei++) {
            existingChildren.push(slotNode.children[ei]);
          }
        } catch (e) { /* ignore */ }
        for (var er = 0; er < existingChildren.length; er++) {
          existingChildren[er].remove();
        }
      }

      slotNode.appendChild(appendedNode);

      // Cloned nodes keep their original x/y, which can land them outside the
      // slot's visible bounds (live-validated: a clone from elsewhere on the
      // page rendered invisible inside a 100×100 slot). In auto-layout slots
      // Figma manages position; in NONE layout, snap to the slot origin.
      if (slotNode.layoutMode === 'NONE' || !slotNode.layoutMode) {
        try { appendedNode.x = 0; appendedNode.y = 0; } catch (e) { /* locked/readonly — leave as-is */ }
      }

      figma.ui.postMessage({
        type: 'APPEND_TO_SLOT_RESULT',
        requestId: msg.requestId,
        success: true,
        slot: { id: slotNode.id, name: slotNode.name },
        appendedNode: {
          id: appendedNode.id,
          name: appendedNode.name,
          type: appendedNode.type,
          width: appendedNode.width,
          height: appendedNode.height
        }
      });
    } catch (error) {
      var appendSlotError = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Append to slot error:', appendSlotError);
      figma.ui.postMessage({
        type: 'APPEND_TO_SLOT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: appendSlotError
      });
    }
  }

  // RESET_SLOT — revert instance slot content to component default
  else if (msg.type === 'RESET_SLOT') {
    try {
      console.log('🌉 [Desktop Bridge] Resetting slot');

      var resetSlotNode = await resolveSlotNode(msg);
      if (typeof resetSlotNode.resetSlot !== 'function') {
        throw new Error('resetSlot() is not available on this node. Ensure Figma Desktop supports Slots (open beta).');
      }

      resetSlotNode.resetSlot();

      figma.ui.postMessage({
        type: 'RESET_SLOT_RESULT',
        requestId: msg.requestId,
        success: true,
        slot: {
          id: resetSlotNode.id,
          name: resetSlotNode.name,
          childCount: resetSlotNode.children ? resetSlotNode.children.length : 0
        }
      });
    } catch (error) {
      var resetSlotError = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Reset slot error:', resetSlotError);
      figma.ui.postMessage({
        type: 'RESET_SLOT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: resetSlotError
      });
    }
  }

  // ============================================================================
  // RESIZE_NODE - Resize any node
  // ============================================================================
  else if (msg.type === 'RESIZE_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Resizing node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('resize' in node)) {
        throw new Error('Node type ' + node.type + ' does not support resize');
      }

      if (msg.withConstraints) {
        node.resize(msg.width, msg.height);
      } else {
        node.resizeWithoutConstraints(msg.width, msg.height);
      }

      console.log('🌉 [Desktop Bridge] Node resized to:', msg.width, 'x', msg.height);

      figma.ui.postMessage({
        type: 'RESIZE_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, width: node.width, height: node.height }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Resize node error:', errorMsg);
      figma.ui.postMessage({
        type: 'RESIZE_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // MOVE_NODE - Move/position a node
  // ============================================================================
  else if (msg.type === 'MOVE_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Moving node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('x' in node)) {
        throw new Error('Node type ' + node.type + ' does not support positioning');
      }

      node.x = msg.x;
      node.y = msg.y;

      console.log('🌉 [Desktop Bridge] Node moved to:', msg.x, ',', msg.y);

      figma.ui.postMessage({
        type: 'MOVE_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, x: node.x, y: node.y }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Move node error:', errorMsg);
      figma.ui.postMessage({
        type: 'MOVE_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_FILLS - Set fills (colors) on a node
  // ============================================================================
  else if (msg.type === 'SET_NODE_FILLS') {
    try {
      console.log('🌉 [Desktop Bridge] Setting fills on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('fills' in node)) {
        throw new Error('Node type ' + node.type + ' does not support fills');
      }

      // Process fills - convert hex colors, and optionally bind a color variable.
      // Color variables bind at the PAINT level (not the node level), so we build
      // the solid paint then attach the binding via setBoundVariableForPaint.
      var processedFills = [];
      for (var fi = 0; fi < msg.fills.length; fi++) {
        var fill = msg.fills[fi];
        if (fill.type === 'SOLID') {
          var baseHex = typeof fill.color === 'string' ? fill.color : '#000000';
          var rgb = hexToFigmaRGB(baseHex);
          var paint = {
            type: 'SOLID',
            color: { r: rgb.r, g: rgb.g, b: rgb.b },
            opacity: rgb.a !== undefined ? rgb.a : (fill.opacity !== undefined ? fill.opacity : 1)
          };
          if (fill.variableId) {
            var fillVar = await figma.variables.getVariableByIdAsync(fill.variableId);
            if (!fillVar) {
              throw new Error('Fill variable not found: "' + fill.variableId + '". Pass a local variable id from figma_get_variables (e.g. "VariableID:1:23"). Library variables must be imported first via figma_import_library_variable.');
            }
            paint = figma.variables.setBoundVariableForPaint(paint, 'color', fillVar);
          }
          processedFills.push(paint);
        } else {
          processedFills.push(fill);
        }
      }

      node.fills = processedFills;

      console.log('🌉 [Desktop Bridge] Fills set successfully');

      figma.ui.postMessage({
        type: 'SET_NODE_FILLS_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set fills error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_FILLS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_IMAGE_FILL - Set an image fill on one or more nodes
  // Receives raw image bytes (as Array) from ui.html which decodes base64
  // ============================================================================
  else if (msg.type === 'SET_IMAGE_FILL') {
    try {
      console.log('🌉 [Desktop Bridge] Setting image fill, bytes:', msg.imageBytes.length);

      // Convert the plain array back to Uint8Array
      var bytes = new Uint8Array(msg.imageBytes);

      // Create the image in Figma
      var image = figma.createImage(bytes);
      var imageHash = image.hash;

      var fill = {
        type: 'IMAGE',
        scaleMode: msg.scaleMode || 'FILL',
        imageHash: imageHash
      };

      // Resolve target nodes
      var nodeIds = msg.nodeIds || (msg.nodeId ? [msg.nodeId] : []);
      var updatedCount = 0;
      var updatedNodes = [];
      var skipWarnings = [];

      for (var i = 0; i < nodeIds.length; i++) {
        var node = await figma.getNodeByIdAsync(nodeIds[i]);
        if (!node) {
          skipWarnings.push('node "' + nodeIds[i] + '" not found');
        } else if (!('fills' in node)) {
          skipWarnings.push('node "' + nodeIds[i] + '" (' + node.type + ') does not support fills');
        } else {
          node.fills = [fill];
          updatedCount++;
          updatedNodes.push({ id: node.id, name: node.name });
        }
      }

      if (updatedCount === 0 && nodeIds.length > 0) {
        throw new Error('Image fill applied to 0 node(s): ' + skipWarnings.join('; '));
      }

      console.log('🌉 [Desktop Bridge] Image fill applied to', updatedCount, 'node(s), hash:', imageHash);

      figma.ui.postMessage({
        type: 'SET_IMAGE_FILL_RESULT',
        requestId: msg.requestId,
        success: true,
        imageHash: imageHash,
        updatedCount: updatedCount,
        nodes: updatedNodes,
        warnings: skipWarnings.length ? skipWarnings : undefined
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set image fill error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_IMAGE_FILL_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_STROKES - Set strokes on a node
  // ============================================================================
  else if (msg.type === 'SET_NODE_STROKES') {
    try {
      console.log('🌉 [Desktop Bridge] Setting strokes on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('strokes' in node)) {
        throw new Error('Node type ' + node.type + ' does not support strokes');
      }

      // Process strokes - convert hex colors, and optionally bind a color variable
      // (paint-level binding, same as fills).
      var processedStrokes = [];
      for (var sti = 0; sti < msg.strokes.length; sti++) {
        var stroke = msg.strokes[sti];
        if (stroke.type === 'SOLID') {
          var sBaseHex = typeof stroke.color === 'string' ? stroke.color : '#000000';
          var srgb = hexToFigmaRGB(sBaseHex);
          var spaint = {
            type: 'SOLID',
            color: { r: srgb.r, g: srgb.g, b: srgb.b },
            opacity: srgb.a !== undefined ? srgb.a : (stroke.opacity !== undefined ? stroke.opacity : 1)
          };
          if (stroke.variableId) {
            var strokeVar = await figma.variables.getVariableByIdAsync(stroke.variableId);
            if (!strokeVar) {
              throw new Error('Stroke variable not found: "' + stroke.variableId + '". Pass a local variable id from figma_get_variables. Library variables must be imported first via figma_import_library_variable.');
            }
            spaint = figma.variables.setBoundVariableForPaint(spaint, 'color', strokeVar);
          }
          processedStrokes.push(spaint);
        } else {
          processedStrokes.push(stroke);
        }
      }

      node.strokes = processedStrokes;

      if (msg.strokeWeight !== undefined) {
        node.strokeWeight = msg.strokeWeight;
      }

      console.log('🌉 [Desktop Bridge] Strokes set successfully');

      figma.ui.postMessage({
        type: 'SET_NODE_STROKES_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set strokes error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_STROKES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_OPACITY - Set opacity on a node
  // ============================================================================
  else if (msg.type === 'SET_NODE_OPACITY') {
    try {
      console.log('🌉 [Desktop Bridge] Setting opacity on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('opacity' in node)) {
        throw new Error('Node type ' + node.type + ' does not support opacity');
      }

      node.opacity = Math.max(0, Math.min(1, msg.opacity));

      console.log('🌉 [Desktop Bridge] Opacity set to:', node.opacity);

      figma.ui.postMessage({
        type: 'SET_NODE_OPACITY_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, opacity: node.opacity }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set opacity error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_OPACITY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_NODE_CORNER_RADIUS - Set corner radius on a node
  // ============================================================================
  else if (msg.type === 'SET_NODE_CORNER_RADIUS') {
    try {
      console.log('🌉 [Desktop Bridge] Setting corner radius on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('cornerRadius' in node)) {
        throw new Error('Node type ' + node.type + ' does not support corner radius');
      }

      node.cornerRadius = msg.radius;

      console.log('🌉 [Desktop Bridge] Corner radius set to:', msg.radius);

      figma.ui.postMessage({
        type: 'SET_NODE_CORNER_RADIUS_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, cornerRadius: node.cornerRadius }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set corner radius error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_NODE_CORNER_RADIUS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // CLONE_NODE - Clone/duplicate a node
  // ============================================================================
  else if (msg.type === 'CLONE_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Cloning node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (!('clone' in node)) {
        throw new Error('Node type ' + node.type + ' does not support cloning');
      }

      var clonedNode = node.clone();

      console.log('🌉 [Desktop Bridge] Node cloned:', clonedNode.id);

      figma.ui.postMessage({
        type: 'CLONE_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: clonedNode.id, name: clonedNode.name, x: clonedNode.x, y: clonedNode.y }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Clone node error:', errorMsg);
      figma.ui.postMessage({
        type: 'CLONE_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // DELETE_NODE - Delete a node
  // ============================================================================
  else if (msg.type === 'DELETE_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Deleting node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      var deletedInfo = { id: node.id, name: node.name };

      node.remove();

      console.log('🌉 [Desktop Bridge] Node deleted');

      figma.ui.postMessage({
        type: 'DELETE_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        deleted: deletedInfo
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Delete node error:', errorMsg);
      figma.ui.postMessage({
        type: 'DELETE_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // RENAME_NODE - Rename a node
  // ============================================================================
  else if (msg.type === 'RENAME_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Renaming node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      var oldName = node.name;
      node.name = msg.newName;

      console.log('🌉 [Desktop Bridge] Node renamed from "' + oldName + '" to "' + msg.newName + '"');

      figma.ui.postMessage({
        type: 'RENAME_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, oldName: oldName }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Rename node error:', errorMsg);
      figma.ui.postMessage({
        type: 'RENAME_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_TEXT_CONTENT - Set text on a text node
  // ============================================================================
  else if (msg.type === 'SET_TEXT_CONTENT') {
    try {
      console.log('🌉 [Desktop Bridge] Setting text content on node:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'TEXT') {
        throw new Error('Node must be a TEXT node. Got: ' + node.type);
      }

      // Load the font(s) first — mutating text in dynamic-page mode requires it.
      // If the caller requested a new family/style, load that (tolerating
      // "SemiBold" vs "Semi Bold"); otherwise load the node's existing font(s),
      // which also handles mixed-font nodes that the old single loadFontAsync
      // call would have crashed on.
      if (msg.fontFamily || msg.fontStyle) {
        var currentFont = (node.fontName && node.fontName !== figma.mixed)
          ? node.fontName
          : { family: 'Inter', style: 'Regular' };
        var targetFamily = msg.fontFamily || currentFont.family;
        var targetStyle = msg.fontStyle || currentFont.style;
        await loadFontsForNode(node); // existing runs, so setting characters is safe
        var loadedFont = await loadFontWithFallback(targetFamily, targetStyle);
        node.characters = msg.text;
        node.fontName = loadedFont;
      } else {
        await loadFontsForNode(node);
        node.characters = msg.text;
      }

      // Apply font properties if specified
      if (msg.fontSize) {
        node.fontSize = msg.fontSize;
      }

      console.log('🌉 [Desktop Bridge] Text content set');

      figma.ui.postMessage({
        type: 'SET_TEXT_CONTENT_RESULT',
        requestId: msg.requestId,
        success: true,
        node: { id: node.id, name: node.name, characters: node.characters }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set text content error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_TEXT_CONTENT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // CREATE_CHILD_NODE - Create a new child node
  // ============================================================================
  else if (msg.type === 'CREATE_CHILD_NODE') {
    try {
      console.log('🌉 [Desktop Bridge] Creating child node of type:', msg.nodeType);

      var parent = await figma.getNodeByIdAsync(msg.parentId);
      if (!parent) {
        throw new Error('Parent node not found: ' + msg.parentId);
      }

      if (!('appendChild' in parent)) {
        throw new Error('Parent node type ' + parent.type + ' does not support children');
      }

      var newNode;
      var props = msg.properties || {};

      switch (msg.nodeType) {
        case 'RECTANGLE':
          newNode = figma.createRectangle();
          break;
        case 'ELLIPSE':
          newNode = figma.createEllipse();
          break;
        case 'FRAME':
          newNode = figma.createFrame();
          break;
        case 'TEXT':
          newNode = figma.createText();
          // Load default font
          await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
          newNode.fontName = { family: 'Inter', style: 'Regular' };
          if (props.text) {
            newNode.characters = props.text;
          }
          break;
        case 'LINE':
          newNode = figma.createLine();
          break;
        case 'POLYGON':
          newNode = figma.createPolygon();
          break;
        case 'STAR':
          newNode = figma.createStar();
          break;
        case 'VECTOR':
          newNode = figma.createVector();
          break;
        default:
          throw new Error('Unsupported node type: ' + msg.nodeType);
      }

      // Apply common properties
      if (props.name) newNode.name = props.name;
      if (props.x !== undefined) newNode.x = props.x;
      if (props.y !== undefined) newNode.y = props.y;
      if (props.width !== undefined || props.height !== undefined) {
        var resizeWidth = props.width !== undefined ? props.width : newNode.width;
        var resizeHeight = props.height !== undefined ? props.height : newNode.height;
        newNode.resize(resizeWidth, resizeHeight);
      }

      // Apply fills if specified
      if (props.fills) {
        var processedFills = props.fills.map(function(fill) {
          if (fill.type === 'SOLID' && typeof fill.color === 'string') {
            var rgb = hexToFigmaRGB(fill.color);
            return {
              type: 'SOLID',
              color: { r: rgb.r, g: rgb.g, b: rgb.b },
              opacity: rgb.a !== undefined ? rgb.a : 1
            };
          }
          return fill;
        });
        newNode.fills = processedFills;
      }

      // Add to parent
      parent.appendChild(newNode);

      console.log('🌉 [Desktop Bridge] Child node created:', newNode.id);

      figma.ui.postMessage({
        type: 'CREATE_CHILD_NODE_RESULT',
        requestId: msg.requestId,
        success: true,
        node: {
          id: newNode.id,
          name: newNode.name,
          type: newNode.type,
          x: newNode.x,
          y: newNode.y,
          width: newNode.width,
          height: newNode.height
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Create child node error:', errorMsg);
      figma.ui.postMessage({
        type: 'CREATE_CHILD_NODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // CAPTURE_SCREENSHOT - Capture node screenshot using plugin exportAsync
  // This captures the CURRENT plugin runtime state (not cloud state like REST API)
  // ============================================================================
  else if (msg.type === 'CAPTURE_SCREENSHOT') {
    try {
      console.log('🌉 [Desktop Bridge] Capturing screenshot for node:', msg.nodeId);

      var node = msg.nodeId ? await figma.getNodeByIdAsync(msg.nodeId) : figma.currentPage;
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      // Verify node supports export
      if (!('exportAsync' in node)) {
        throw new Error('Node type ' + node.type + ' does not support export');
      }

      // Configure export settings — AI-optimized defaults (PNG 1x)
      var format = msg.format || 'PNG';
      var scale = msg.scale || 1;

      // AI vision cap: Claude API resizes images to 1568px on the longest side
      // before processing, so exporting larger just wastes bandwidth and tokens.
      var AI_MAX_DIMENSION = 1568;
      var nodeWidth = 0;
      var nodeHeight = 0;

      if (node.type === 'PAGE') {
        // Pages don't have fixed dimensions — calculate from visible children
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < node.children.length; i++) {
          var child = node.children[i];
          if (child.visible !== false && 'absoluteBoundingBox' in child && child.absoluteBoundingBox) {
            var bb = child.absoluteBoundingBox;
            minX = Math.min(minX, bb.x);
            minY = Math.min(minY, bb.y);
            maxX = Math.max(maxX, bb.x + bb.width);
            maxY = Math.max(maxY, bb.y + bb.height);
          }
        }
        if (minX !== Infinity) {
          nodeWidth = maxX - minX;
          nodeHeight = maxY - minY;
        }
      } else if ('width' in node && 'height' in node) {
        nodeWidth = node.width;
        nodeHeight = node.height;
      }

      // Cap scale so the longest exported side doesn't exceed the AI processing ceiling
      if (nodeWidth > 0 && nodeHeight > 0) {
        var longestSide = Math.max(nodeWidth, nodeHeight);
        var exportedLongest = longestSide * scale;
        if (exportedLongest > AI_MAX_DIMENSION) {
          var cappedScale = AI_MAX_DIMENSION / longestSide;
          console.log('🌉 [Desktop Bridge] Capping scale from', scale, 'to', cappedScale.toFixed(3),
            '(node ' + Math.round(longestSide) + 'px, cap ' + AI_MAX_DIMENSION + 'px)');
          scale = cappedScale;
        }
      }

      // Analyze node content to recommend optimal format
      var imageCount = 0;
      var gradientCount = 0;
      var textCount = 0;
      var vectorCount = 0;
      var maxDepth = 3; // Don't recurse too deep — top-level composition is enough

      function analyzeContent(n, depth) {
        if (depth > maxDepth) return;
        if (n.type === 'TEXT') { textCount++; return; }
        if (n.type === 'VECTOR' || n.type === 'LINE' || n.type === 'STAR' ||
            n.type === 'POLYGON' || n.type === 'ELLIPSE' || n.type === 'BOOLEAN_OPERATION') {
          vectorCount++; return;
        }
        // Check fills for images and gradients
        if ('fills' in n && Array.isArray(n.fills)) {
          for (var f = 0; f < n.fills.length; f++) {
            var fill = n.fills[f];
            if (fill.visible === false) continue;
            if (fill.type === 'IMAGE') imageCount++;
            if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL' ||
                fill.type === 'GRADIENT_ANGULAR' || fill.type === 'GRADIENT_DIAMOND') gradientCount++;
          }
        }
        // Recurse into children
        if ('children' in n) {
          for (var c = 0; c < n.children.length; c++) {
            if (n.children[c].visible !== false) {
              analyzeContent(n.children[c], depth + 1);
            }
          }
        }
      }
      analyzeContent(node, 0);

      var totalElements = imageCount + gradientCount + textCount + vectorCount;
      var photoHeavy = totalElements > 0 && (imageCount + gradientCount) / totalElements > 0.5;
      var adviceParts = [];

      // Format advice
      if (photoHeavy) {
        adviceParts.push('Image/gradient-heavy content — try format: "JPG" for smaller file.');
      }

      // Scale capping advice
      if (scale < (msg.scale || 1)) {
        adviceParts.push('Scale capped from ' + (msg.scale || 1) + 'x to ' +
          scale.toFixed(2) + 'x (AI vision max: 1568px).');
      }

      // Scope advice for full-page captures with heavy downscaling
      if (node.type === 'PAGE' && scale < 0.5) {
        adviceParts.push('Full-page capture at ' + scale.toFixed(2) +
          'x — text may be unreadable. Pass a nodeId to target a specific frame or component.');
      }

      var formatAdvice = adviceParts.join(' ');

      var exportSettings = {
        format: format,
        constraint: { type: 'SCALE', value: scale }
      };

      // Export the node
      var bytes = await node.exportAsync(exportSettings);

      // Convert to base64
      var base64 = figma.base64Encode(bytes);

      // Get node bounds for context
      var bounds = null;
      if ('absoluteBoundingBox' in node) {
        bounds = node.absoluteBoundingBox;
      }

      console.log('🌉 [Desktop Bridge] Screenshot captured:', bytes.length, 'bytes (' + format + ' @ ' + scale.toFixed(2) + 'x)');

      figma.ui.postMessage({
        type: 'CAPTURE_SCREENSHOT_RESULT',
        requestId: msg.requestId,
        success: true,
        image: {
          base64: base64,
          format: format,
          scale: scale,
          byteLength: bytes.length,
          node: {
            id: node.id,
            name: node.name,
            type: node.type
          },
          bounds: bounds,
          formatAdvice: formatAdvice
        }
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Screenshot capture error:', errorMsg);
      figma.ui.postMessage({
        type: 'CAPTURE_SCREENSHOT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // GET_FILE_INFO - Report which file this plugin instance is running in
  // Used by WebSocket bridge to identify the connected file
  // ============================================================================
  else if (msg.type === 'GET_FILE_INFO') {
    try {
      var selection = figma.currentPage.selection;
      figma.ui.postMessage({
        type: 'GET_FILE_INFO_RESULT',
        requestId: msg.requestId,
        success: true,
        fileInfo: {
          fileName: figma.root.name,
          fileKey: figma.fileKey || null,
          currentPage: figma.currentPage.name,
          currentPageId: figma.currentPage.id,
          selectionCount: selection ? selection.length : 0,
          pluginVersion: PLUGIN_VERSION,
          editorType: __editorType
        }
      });
    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      figma.ui.postMessage({
        type: 'GET_FILE_INFO_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // RESIZE_UI - Dynamically resize the plugin window (e.g., Cloud Mode toggle)
  // ============================================================================
  else if (msg.type === 'RESIZE_UI') {
    figma.ui.resize(msg.width || 120, msg.height || 36);
  }

  // ============================================================================
  // STORE_CLOUD_CONFIG - Persist cloud pairing config in clientStorage
  // ============================================================================
  else if (msg.type === 'STORE_CLOUD_CONFIG') {
    figma.clientStorage.setAsync('cloudConfig', { code: msg.code, timestamp: Date.now() })
      .catch(function() { /* non-critical */ });
  }

  // ============================================================================
  // RELOAD_UI - Reload the plugin UI iframe (re-establishes WebSocket connection)
  // Uses figma.showUI(__html__) to reload without restarting code.js
  // ============================================================================
  else if (msg.type === 'RELOAD_UI') {
    try {
      console.log('🌉 [Desktop Bridge] Reloading plugin UI');
      figma.ui.postMessage({
        type: 'RELOAD_UI_RESULT',
        requestId: msg.requestId,
        success: true
      });
      // Short delay to let the response message be sent before reload
      setTimeout(function() {
        figma.showUI(__html__, { width: 240, height: 40, visible: true, themeColors: true });
      }, 100);
    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      figma.ui.postMessage({
        type: 'RELOAD_UI_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // SET_INSTANCE_PROPERTIES - Update component properties on an instance
  // Uses instance.setProperties() to update TEXT, BOOLEAN, INSTANCE_SWAP, VARIANT
  // ============================================================================
  else if (msg.type === 'SET_INSTANCE_PROPERTIES') {
    try {
      console.log('🌉 [Desktop Bridge] Setting instance properties on:', msg.nodeId);

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) {
        throw new Error('Node not found: ' + msg.nodeId);
      }

      if (node.type !== 'INSTANCE') {
        throw new Error('Node must be an INSTANCE. Got: ' + node.type);
      }

      // Load main component first (required for documentAccess: dynamic-page)
      var mainComponent = await node.getMainComponentAsync();

      // Get current properties for reference
      var currentProps = node.componentProperties;
      console.log('🌉 [Desktop Bridge] Current properties:', JSON.stringify(Object.keys(currentProps)));

      // Build the properties object
      // Note: TEXT, BOOLEAN, INSTANCE_SWAP properties use the format "PropertyName#nodeId"
      // VARIANT properties use just "PropertyName"
      var propsToSet = {};
      var propUpdates = msg.properties || {};
      var propWarnings = [];
      var hasTextProp = false;

      for (var propName in propUpdates) {
        if (!propUpdates.hasOwnProperty(propName)) continue;
        var newValue = propUpdates[propName];
        var resolvedName = resolvePropertyName(currentProps, propName);

        if (resolvedName !== null) {
          propsToSet[resolvedName] = newValue;
          if (currentProps[resolvedName] && currentProps[resolvedName].type === 'TEXT') {
            hasTextProp = true;
          }
          console.log('🌉 [Desktop Bridge] Setting property:', resolvedName, '=', newValue);
        } else {
          console.warn('🌉 [Desktop Bridge] Property not found:', propName, '- Available:', Object.keys(currentProps).join(', '));
          propWarnings.push('property "' + propName + '" not found; available: ' + Object.keys(currentProps).join(', '));
        }
      }

      if (Object.keys(propsToSet).length === 0) {
        throw new Error('No valid properties to set. Available properties: ' + Object.keys(currentProps).join(', '));
      }

      // Pre-load fonts before applying TEXT-property values. Mutating text
      // content in dynamic-page mode throws unless fonts are already loaded.
      if (hasTextProp) {
        await loadFontsForNode(node);
      }

      // Apply the properties
      node.setProperties(propsToSet);

      // Get updated properties
      var updatedProps = node.componentProperties;

      console.log('🌉 [Desktop Bridge] Instance properties updated');

      figma.ui.postMessage({
        type: 'SET_INSTANCE_PROPERTIES_RESULT',
        requestId: msg.requestId,
        success: true,
        instance: {
          id: node.id,
          name: node.name,
          componentId: mainComponent ? mainComponent.id : null,
          propertiesSet: Object.keys(propsToSet),
          currentProperties: Object.keys(updatedProps).reduce(function(acc, key) {
            acc[key] = {
              type: updatedProps[key].type,
              value: updatedProps[key].value
            };
            return acc;
          }, {})
        },
        warnings: propWarnings.length ? propWarnings : undefined
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Set instance properties error:', errorMsg);
      figma.ui.postMessage({
        type: 'SET_INSTANCE_PROPERTIES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // LINT_DESIGN - Accessibility and design quality checks on node tree
  // ============================================================================
  else if (msg.type === 'LINT_DESIGN') {
    try {
      console.log('🌉 [Desktop Bridge] Running design lint...');

      // ---- Helper functions ----

      // sRGB linearization
      function lintLinearize(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }

      // Relative luminance (r, g, b in 0-1 range)
      function lintLuminance(r, g, b) {
        return 0.2126 * lintLinearize(r) + 0.7152 * lintLinearize(g) + 0.0722 * lintLinearize(b);
      }

      // Contrast ratio between two colors (each r, g, b in 0-1)
      function lintContrastRatio(r1, g1, b1, r2, g2, b2) {
        var l1 = lintLuminance(r1, g1, b1);
        var l2 = lintLuminance(r2, g2, b2);
        var lighter = Math.max(l1, l2);
        var darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      // Convert 0-1 RGB to hex string
      function lintRgbToHex(r, g, b) {
        var rr = Math.round(r * 255).toString(16);
        var gg = Math.round(g * 255).toString(16);
        var bb = Math.round(b * 255).toString(16);
        if (rr.length === 1) rr = '0' + rr;
        if (gg.length === 1) gg = '0' + gg;
        if (bb.length === 1) bb = '0' + bb;
        return '#' + rr.toUpperCase() + gg.toUpperCase() + bb.toUpperCase();
      }

      // Walk up ancestors to find nearest solid fill background color
      function lintGetEffectiveBg(node) {
        var current = node.parent;
        while (current) {
          try {
            if (current.fills && current.fills.length > 0) {
              // Iterate reverse (last = topmost visible fill in Figma's stack)
              for (var fi = current.fills.length - 1; fi >= 0; fi--) {
                var fill = current.fills[fi];
                if (fill.type === 'SOLID' && fill.visible !== false) {
                  var opacity = (fill.opacity !== undefined) ? fill.opacity : 1;
                  return { r: fill.color.r, g: fill.color.g, b: fill.color.b, opacity: opacity };
                }
              }
            }
          } catch (e) {
            // Slot sublayer — skip
          }
          current = current.parent;
        }
        // Default to white if no bg found
        return { r: 1, g: 1, b: 1, opacity: 1 };
      }

      // Check if text qualifies as "large" per WCAG (18pt=24px regular, 14pt≈18.66px bold 700+)
      function lintIsLargeText(fontSize, fontWeight) {
        if (fontSize >= 24) return true;
        if (fontSize >= 18.66 && fontWeight && (fontWeight === 'Bold' || fontWeight === 'Black' || fontWeight === 'ExtraBold')) return true;
        return false;
      }

      // Line/paragraph SPACING only affects readability when text actually renders on
      // 2+ lines (or 2+ paragraphs). Single-line labels, buttons, inputs and headings
      // gain nothing from a 1.5 line height, so flagging them is false-positive noise.
      // (WCAG 1.4.12 conformance is a code concern — whether spacing overrides break
      // layout — not something a design's spacing value can prove. These stay best-practice.)
      function textRendersMultipleLines(node, effectiveLh) {
        try {
          var chars = (typeof node.characters === 'string') ? node.characters : '';
          // \n = paragraph break; U+2028 = line break (shift-enter) within a Figma paragraph
          var LINE_SEP = String.fromCharCode(0x2028);
          if (chars.indexOf(String.fromCharCode(10)) !== -1 || chars.indexOf(LINE_SEP) !== -1) return true;
          // WIDTH_AND_HEIGHT auto-resize grows horizontally and never wraps on its own
          if (node.textAutoResize === 'WIDTH_AND_HEIGHT') return false;
          if (effectiveLh && typeof node.height === 'number' && node.height > 0) {
            return (node.height / effectiveLh) >= 1.6; // ≈ 2+ rendered lines
          }
        } catch (e) { /* mixed/slot — treat as single line */ }
        return false;
      }

      function textHasMultipleParagraphs(node) {
        try {
          var chars = (typeof node.characters === 'string') ? node.characters : '';
          return chars.indexOf('\n') !== -1; // \n = paragraph separator in Figma text
        } catch (e) { /* ignore */ }
        return false;
      }

      // ---- Rule configuration ----
      var allRuleIds = [
        'wcag-contrast', 'wcag-text-size', 'wcag-target-size', 'wcag-line-height',
        'wcag-non-text-contrast', 'wcag-color-only', 'wcag-focus-indicator',
        'wcag-letter-spacing', 'wcag-paragraph-spacing', 'wcag-image-alt',
        'wcag-heading-hierarchy', 'wcag-reflow', 'wcag-reading-order',
        'wcag-disabled-no-context', 'token-misuse',
        'hardcoded-color', 'no-text-style', 'default-name', 'detached-component',
        'no-autolayout', 'empty-container'
      ];

      var ruleGroups = {
        'all': allRuleIds,
        // 'wcag' = genuine WCAG conformance criteria only. Readability "best practice"
        // checks (text size, line/letter/paragraph spacing) live in 'best-practice' so a
        // conformance audit (rules: ['wcag']) is not polluted by non-normative hints.
        // In particular, WCAG 1.4.12 Text Spacing is a "support user overrides without
        // breaking" criterion — NOT a requirement to ship specific spacing values — so a
        // sub-1.5 line height is not a conformance failure (see 'best-practice' below).
        'wcag': [
          'wcag-contrast', 'wcag-target-size',
          'wcag-non-text-contrast', 'wcag-color-only', 'wcag-focus-indicator',
          'wcag-image-alt', 'wcag-heading-hierarchy', 'wcag-reflow', 'wcag-reading-order',
          'wcag-disabled-no-context'
        ],
        // Readability best practices — useful hints, NOT WCAG conformance failures.
        // Opt in with rules: ['best-practice'] (or ['all']); excluded from the default set.
        'best-practice': [
          'wcag-text-size', 'wcag-line-height', 'wcag-letter-spacing', 'wcag-paragraph-spacing'
        ],
        'design-system': ['hardcoded-color', 'no-text-style', 'default-name', 'detached-component', 'token-misuse'],
        'layout': ['no-autolayout', 'empty-container']
      };

      var severityMap = {
        'wcag-contrast': 'critical',
        'wcag-target-size': 'critical',
        'wcag-non-text-contrast': 'critical',
        'wcag-color-only': 'critical',
        'wcag-focus-indicator': 'critical',
        'wcag-text-size': 'warning',
        'wcag-letter-spacing': 'warning',
        'wcag-image-alt': 'warning',
        'wcag-heading-hierarchy': 'warning',
        'wcag-reflow': 'warning',
        'wcag-reading-order': 'warning',
        'wcag-disabled-no-context': 'warning',
        'wcag-line-height': 'info',
        'wcag-paragraph-spacing': 'info',
        'token-misuse': 'warning',
        'hardcoded-color': 'warning',
        'no-text-style': 'warning',
        'default-name': 'warning',
        'detached-component': 'warning',
        'no-autolayout': 'warning',
        'empty-container': 'info'
      };

      // WCAG conformance level per rule — lets teams filter by target level (AA vs AAA)
      var wcagLevelMap = {
        'wcag-contrast': 'aa',           // 1.4.3 Contrast (Minimum) — Level AA
        'wcag-target-size': 'aa',        // 2.5.8 Target Size (Minimum) — Level AA
        'wcag-non-text-contrast': 'aa',  // 1.4.11 Non-text Contrast — Level AA
        'wcag-color-only': 'a',          // 1.4.1 Use of Color — Level A
        'wcag-focus-indicator': 'aa',    // 2.4.7 Focus Visible — Level AA
        'wcag-text-size': 'best-practice', // Not actually 1.4.4; 12px minimum is a readability best practice
        'wcag-line-height': 'best-practice', // 1.4.12 is about supporting user overrides, not requiring specific values
        'wcag-letter-spacing': 'best-practice', // Negative spacing actively harms readability
        'wcag-paragraph-spacing': 'best-practice', // 1.4.12 is about supporting user overrides
        'wcag-image-alt': 'a',           // 1.1.1 Non-text Content — Level A
        'wcag-heading-hierarchy': 'a',   // 1.3.1 Info and Relationships — Level A
        'wcag-reflow': 'aa',            // 1.4.10 Reflow — Level AA
        'wcag-reading-order': 'a',       // 1.3.2 Meaningful Sequence — Level A
        'wcag-disabled-no-context': 'aa', // 4.1.2 Name, Role, Value — disabled elements need ARIA context
        'token-misuse': 'design-system',
        'hardcoded-color': 'design-system',
        'no-text-style': 'design-system',
        'default-name': 'design-system',
        'detached-component': 'design-system',
        'no-autolayout': 'design-system',
        'empty-container': 'design-system'
      };

      var ruleDescriptions = {
        'wcag-contrast': 'Text does not meet WCAG AA contrast ratio (4.5:1 normal, 3:1 large text ≥24px or ≥18.5px bold). Best practice: always target 4.5:1, especially in dark mode.',
        'wcag-text-size': 'Text size is below 12px — readability best practice. Note: WCAG 1.4.4 requires supporting 200% text-only zoom (use rem/em units), not a specific minimum size.',
        'wcag-target-size': 'Interactive element is smaller than 24x24px minimum target size (WCAG 2.5.8)',
        'wcag-line-height': 'Multi-line body text has line height below 1.5x font size — a readability best practice (only flagged on text that wraps to 2+ lines; single-line labels, buttons and headings are exempt). NOT a WCAG failure: 1.4.12 requires content to survive a user overriding line height to 1.5x without loss of content, which is verified in code, not by the default value in the design.',
        'wcag-non-text-contrast': 'UI component or graphical object does not meet 3:1 contrast ratio against adjacent color. Also applies to borders and chart elements against adjacent elements (WCAG 1.4.11)',
        'wcag-color-only': 'Information is conveyed only through color change (e.g., error state uses red border without an error message or icon). Color can supplement but must not be the sole indicator (WCAG 1.4.1)',
        'wcag-focus-indicator': 'Interactive component is missing a focus/focused variant or the focus indicator is insufficient. A visible focus state is critical — without it, keyboard users cannot navigate the interface (WCAG 2.4.7)',
        'wcag-letter-spacing': 'Negative letter spacing (tighter than default) harms readability — a best-practice hint, not a WCAG failure. WCAG 1.4.12 is about supporting user-overridden spacing without loss of content (verified in code), not the default tracking in the design.',
        'wcag-paragraph-spacing': 'Multi-paragraph text has paragraph spacing below 2x font size — a readability best practice (only flagged when a text node has 2+ paragraphs). NOT a WCAG failure: 1.4.12 requires content to survive a user overriding paragraph spacing to 2x without loss of content, verified in code, not by the default value in the design.',
        'wcag-image-alt': 'Image or image fill has no description annotation for alternative text. All images need alt text; decorative images should be explicitly marked as decorative. Graphs and charts also need long descriptions (e.g., a data table) (WCAG 1.1.1)',
        'wcag-heading-hierarchy': 'Heading levels skip a level (e.g., H1 followed by H3). Use H1 through H6 sequentially without skipping levels (WCAG 1.3.1)',
        'wcag-reflow': 'Frame uses fixed positioning without auto-layout. Content must support 400% zoom on 1280px viewport (equivalent to 320px minimum width) without horizontal scrolling or loss of content (WCAG 1.4.10)',
        'wcag-reading-order': 'Visual position of elements does not match layer order. Keyboard navigation and screen reader order must follow a logical sequence (WCAG 1.3.2)',
        'wcag-disabled-no-context': 'Disabled variant has no tooltip, helper text, or annotation explaining why the element is disabled. Use aria-disabled (not HTML disabled) to keep the element focusable for screen readers, and add a tooltip so all users understand the disabled reason.',
        'token-misuse': 'Variable name prefix does not match its usage context (e.g., a bg/* token used as a text fill, or a text/* token used as a background). This may cause contrast issues and indicates a misbound token.',
        'hardcoded-color': 'Fill color is not bound to a variable or style',
        'no-text-style': 'Text node is not using a text style',
        'default-name': 'Node has a default Figma name (e.g., "Frame 1")',
        'detached-component': 'Frame uses component naming convention but is not a component or instance',
        'no-autolayout': 'Frame with multiple children does not use auto-layout',
        'empty-container': 'Frame has no children'
      };

      var defaultNameRegex = /^(Frame|Rectangle|Ellipse|Line|Text|Group|Component|Instance|Vector|Polygon|Star|Section)(\s+\d+)?$/;
      var interactiveNameRegex = /button|link|input|checkbox|radio|switch|toggle|tab|menu-item/i;

      // ---- Additional helpers for new WCAG rules ----

      // Get the first visible solid fill color from a node (for non-text contrast)
      function lintGetNodeFillColor(node) {
        try {
          var fills = node.fills;
          if (fills && fills.length > 0) {
            for (var i = fills.length - 1; i >= 0; i--) {
              if (fills[i].type === 'SOLID' && fills[i].visible !== false) {
                return { r: fills[i].color.r, g: fills[i].color.g, b: fills[i].color.b };
              }
            }
          }
        } catch (e) { /* slot sublayer */ }
        return null;
      }

      // Get the first visible solid stroke color from a node
      function lintGetNodeStrokeColor(node) {
        try {
          var strokes = node.strokes;
          if (strokes && strokes.length > 0) {
            for (var i = strokes.length - 1; i >= 0; i--) {
              if (strokes[i].type === 'SOLID' && strokes[i].visible !== false) {
                return { r: strokes[i].color.r, g: strokes[i].color.g, b: strokes[i].color.b };
              }
            }
          }
        } catch (e) { /* slot sublayer */ }
        return null;
      }

      // Check if a node has any non-color visual differentiation (icon children, text change, border)
      function lintHasNonColorIndicator(node) {
        try {
          if (!node.children) return false;
          for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            try {
              // Icons are typically vectors, instances, or small frames with vector children
              if (child.type === 'VECTOR' || child.type === 'BOOLEAN_OPERATION') return true;
              if (child.type === 'INSTANCE') return true;
              // Check for visible strokes (borders)
              if (child.strokes && child.strokes.length > 0) {
                for (var si = 0; si < child.strokes.length; si++) {
                  if (child.strokes[si].visible !== false) return true;
                }
              }
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* no children */ }
        return false;
      }

      // Heading level detection from text style name or font size
      var headingStyleRegex = /\bh(\d)\b|heading[\s-]*(\d)/i;
      function lintGetHeadingLevel(node) {
        // Try text style name first
        try {
          if (node.textStyleId && typeof node.textStyleId === 'string') {
            // We can't resolve style name in plugin sandbox directly from ID alone,
            // but we check the node name and font size as fallback
          }
        } catch (e) { /* skip */ }
        // Check node name for heading patterns
        try {
          var match = headingStyleRegex.exec(node.name);
          if (match) return parseInt(match[1] || match[2], 10);
        } catch (e) { /* skip */ }
        // Infer from font size (common convention)
        try {
          var fs = node.fontSize;
          if (typeof fs === 'number') {
            if (fs >= 40) return 1;
            if (fs >= 32) return 2;
            if (fs >= 24) return 3;
            if (fs >= 20) return 4;
            if (fs >= 18) return 5;
          }
        } catch (e) { /* mixed */ }
        return 0; // Not a heading
      }

      // Tracking for heading hierarchy check (reset per root scan)
      var headingSequence = [];

      // Tracking for reading order check — collect positioned children per parent
      // (checked after tree walk per-frame)

      // ---- Resolve active rules ----
      // Default audit = real WCAG conformance + design-system + layout. Best-practice
      // readability hints are opt-in (rules: ['best-practice'] or ['all']) so component
      // library audits aren't flooded with non-normative spacing/size noise.
      var requestedRules = msg.rules || ['wcag', 'design-system', 'layout'];
      var activeRuleSet = {};
      for (var ri = 0; ri < requestedRules.length; ri++) {
        var ruleOrGroup = requestedRules[ri];
        if (ruleGroups[ruleOrGroup]) {
          var groupRules = ruleGroups[ruleOrGroup];
          for (var gi = 0; gi < groupRules.length; gi++) {
            activeRuleSet[groupRules[gi]] = true;
          }
        } else if (severityMap[ruleOrGroup]) {
          activeRuleSet[ruleOrGroup] = true;
        }
      }

      var maxDepth = typeof msg.maxDepth === 'number' ? msg.maxDepth : 10;
      var maxFindings = typeof msg.maxFindings === 'number' ? msg.maxFindings : 100;

      // ---- Resolve root node ----
      var rootNode;
      if (msg.nodeId) {
        rootNode = await figma.getNodeByIdAsync(msg.nodeId);
        if (!rootNode) {
          throw new Error('Node not found: ' + msg.nodeId);
        }
      } else {
        rootNode = figma.currentPage;
      }

      // ---- Collect context (styles and variables for design-system rules) ----
      var paintStyleIds = {};
      var textStyleIds = {};
      var variableIds = {};

      if (activeRuleSet['hardcoded-color'] || activeRuleSet['no-text-style']) {
        try {
          var paintStyles = await figma.getLocalPaintStylesAsync();
          for (var pi = 0; pi < paintStyles.length; pi++) {
            paintStyleIds[paintStyles[pi].id] = true;
          }
        } catch (e) { /* ignore */ }

        try {
          var textStyles = await figma.getLocalTextStylesAsync();
          for (var ti = 0; ti < textStyles.length; ti++) {
            textStyleIds[textStyles[ti].id] = true;
          }
        } catch (e) { /* ignore */ }

        try {
          var localVars = await figma.variables.getLocalVariablesAsync();
          for (var vi = 0; vi < localVars.length; vi++) {
            variableIds[localVars[vi].id] = true;
          }
        } catch (e) { /* ignore */ }
      }

      // ---- Findings storage ----
      var findings = {};
      for (var ai = 0; ai < allRuleIds.length; ai++) {
        if (activeRuleSet[allRuleIds[ai]]) {
          findings[allRuleIds[ai]] = [];
        }
      }
      var totalFindings = 0;
      var nodesScanned = 0;
      var truncated = false;

      // ---- Tree walk ----
      function walkNode(node, depth) {
        if (depth > maxDepth) return;
        if (truncated) return;

        nodesScanned++;

        var nodeType, nodeName, nodeId;
        try {
          nodeType = node.type;
          nodeName = node.name;
          nodeId = node.id;
        } catch (e) {
          return; // Slot sublayer — skip entirely
        }

        // Skip pages for most checks but still recurse into their children
        var isPage = nodeType === 'PAGE';
        var isSection = nodeType === 'SECTION';

        // ---- WCAG checks ----

        // wcag-contrast: TEXT nodes
        if (activeRuleSet['wcag-contrast'] && nodeType === 'TEXT' && !truncated) {
          try {
            var fills = node.fills;
            if (fills && fills.length > 0) {
              for (var fci = 0; fci < fills.length; fci++) {
                if (fills[fci].type === 'SOLID' && fills[fci].visible !== false) {
                  var fg = fills[fci].color;
                  var bg = lintGetEffectiveBg(node);
                  var ratio = lintContrastRatio(fg.r, fg.g, fg.b, bg.r, bg.g, bg.b);
                  var fontSize = 16;
                  var fontWeight = null;
                  try { fontSize = node.fontSize; } catch (e) { /* mixed */ }
                  try { fontWeight = node.fontWeight; } catch (e) { /* mixed */ }
                  if (typeof fontSize !== 'number') fontSize = 16;
                  var isLarge = lintIsLargeText(fontSize, fontWeight);
                  var required = isLarge ? 3.0 : 4.5;
                  var fgOpacity = (fills[fci].opacity !== undefined) ? fills[fci].opacity : 1;
                  var approximate = fgOpacity < 1 || bg.opacity < 1;
                  if (ratio < required) {
                    if (totalFindings < maxFindings) {
                      var finding = {
                        id: nodeId,
                        name: nodeName,
                        ratio: ratio.toFixed(1) + ':1',
                        required: required.toFixed(1) + ':1',
                        fg: lintRgbToHex(fg.r, fg.g, fg.b),
                        bg: lintRgbToHex(bg.r, bg.g, bg.b)
                      };
                      if (approximate) finding.approximate = true;
                      findings['wcag-contrast'].push(finding);
                      totalFindings++;
                    } else {
                      truncated = true;
                    }
                  }
                  break; // Only check the first visible solid fill
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-text-size: TEXT nodes with fontSize < 12
        if (activeRuleSet['wcag-text-size'] && nodeType === 'TEXT' && !truncated) {
          try {
            var ts = node.fontSize;
            if (typeof ts === 'number' && ts < 12) {
              if (totalFindings < maxFindings) {
                findings['wcag-text-size'].push({
                  id: nodeId,
                  name: nodeName,
                  fontSize: ts
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-target-size: Interactive elements < 24x24
        if (activeRuleSet['wcag-target-size'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' || nodeType === 'COMPONENT_SET') && interactiveNameRegex.test(nodeName)) {
              var tw = node.width;
              var th = node.height;
              if ((typeof tw === 'number' && tw < 24) || (typeof th === 'number' && th < 24)) {
                if (totalFindings < maxFindings) {
                  findings['wcag-target-size'].push({
                    id: nodeId,
                    name: nodeName,
                    width: tw,
                    height: th
                  });
                  totalFindings++;
                } else {
                  truncated = true;
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-line-height: TEXT nodes where lineHeight < 1.5 * fontSize
        if (activeRuleSet['wcag-line-height'] && nodeType === 'TEXT' && !truncated) {
          try {
            var lh = node.lineHeight;
            var fs = node.fontSize;
            var effectiveLh = null;
            if (lh && typeof fs === 'number' && typeof lh === 'object' && typeof lh.value === 'number') {
              if (lh.unit === 'PIXELS') {
                effectiveLh = lh.value;
              } else if (lh.unit === 'PERCENT') {
                effectiveLh = fs * (lh.value / 100);
              }
            }
            if (effectiveLh !== null && effectiveLh < 1.5 * fs && textRendersMultipleLines(node, effectiveLh)) {
              if (totalFindings < maxFindings) {
                findings['wcag-line-height'].push({
                  id: nodeId,
                  name: nodeName,
                  lineHeight: effectiveLh,
                  fontSize: fs,
                  recommended: (1.5 * fs).toFixed(1)
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-non-text-contrast: UI components need 3:1 against adjacent color (WCAG 1.4.11)
        if (activeRuleSet['wcag-non-text-contrast'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' || nodeType === 'COMPONENT_SET') && interactiveNameRegex.test(nodeName)) {
              var uiFill = lintGetNodeFillColor(node);
              var uiStroke = lintGetNodeStrokeColor(node);
              var uiBg = lintGetEffectiveBg(node);
              // Check fill against background
              if (uiFill) {
                var uiRatio = lintContrastRatio(uiFill.r, uiFill.g, uiFill.b, uiBg.r, uiBg.g, uiBg.b);
                if (uiRatio < 3.0) {
                  if (totalFindings < maxFindings) {
                    findings['wcag-non-text-contrast'].push({
                      id: nodeId,
                      name: nodeName,
                      ratio: uiRatio.toFixed(1) + ':1',
                      required: '3.0:1',
                      component: lintRgbToHex(uiFill.r, uiFill.g, uiFill.b),
                      bg: lintRgbToHex(uiBg.r, uiBg.g, uiBg.b),
                      element: 'fill'
                    });
                    totalFindings++;
                  } else { truncated = true; }
                }
              }
              // Check stroke/border against background
              if (uiStroke && !truncated) {
                var strokeRatio = lintContrastRatio(uiStroke.r, uiStroke.g, uiStroke.b, uiBg.r, uiBg.g, uiBg.b);
                if (strokeRatio < 3.0) {
                  if (totalFindings < maxFindings) {
                    findings['wcag-non-text-contrast'].push({
                      id: nodeId,
                      name: nodeName,
                      ratio: strokeRatio.toFixed(1) + ':1',
                      required: '3.0:1',
                      component: lintRgbToHex(uiStroke.r, uiStroke.g, uiStroke.b),
                      bg: lintRgbToHex(uiBg.r, uiBg.g, uiBg.b),
                      element: 'stroke'
                    });
                    totalFindings++;
                  } else { truncated = true; }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-color-only: Component variants that differ only by color (WCAG 1.4.1)
        if (activeRuleSet['wcag-color-only'] && nodeType === 'COMPONENT_SET' && !truncated) {
          try {
            var variants = node.children;
            if (variants && variants.length >= 2) {
              // Compare each variant pair for color-only differentiation
              for (var vi = 0; vi < variants.length && !truncated; vi++) {
                var variant = variants[vi];
                try {
                  var vName = variant.name.toLowerCase();
                  // Only check state-related variants (error, warning, success, disabled)
                  if (/(error|warning|danger|success|invalid|alert)/.test(vName)) {
                    if (!lintHasNonColorIndicator(variant)) {
                      // Check if this variant's fill differs from default
                      var defaultVariant = null;
                      for (var dvi = 0; dvi < variants.length; dvi++) {
                        var dvName = variants[dvi].name.toLowerCase();
                        if (/(default|rest|idle|normal|base)/.test(dvName) || dvi === 0) {
                          defaultVariant = variants[dvi];
                          break;
                        }
                      }
                      if (defaultVariant) {
                        var varFill = lintGetNodeFillColor(variant);
                        var defFill = lintGetNodeFillColor(defaultVariant);
                        if (varFill && defFill && (varFill.r !== defFill.r || varFill.g !== defFill.g || varFill.b !== defFill.b)) {
                          if (totalFindings < maxFindings) {
                            findings['wcag-color-only'].push({
                              id: variant.id,
                              name: nodeName + ' / ' + variant.name,
                              variantColor: lintRgbToHex(varFill.r, varFill.g, varFill.b),
                              defaultColor: lintRgbToHex(defFill.r, defFill.g, defFill.b),
                              suggestion: 'Add an icon, text label, or border to differentiate this state beyond color alone'
                            });
                            totalFindings++;
                          } else { truncated = true; }
                        }
                      }
                    }
                  }
                } catch (e) { /* skip variant */ }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-focus-indicator: Interactive components missing focus variant (WCAG 2.4.7)
        if (activeRuleSet['wcag-focus-indicator'] && nodeType === 'COMPONENT_SET' && !truncated) {
          try {
            if (interactiveNameRegex.test(nodeName)) {
              var hasFocusVariant = false;
              var focusVariantNode = null;
              var csVariants = node.children;
              if (csVariants) {
                for (var fvi = 0; fvi < csVariants.length; fvi++) {
                  var fvName = csVariants[fvi].name.toLowerCase();
                  if (/focus|focused/.test(fvName)) {
                    hasFocusVariant = true;
                    focusVariantNode = csVariants[fvi];
                    break;
                  }
                }
              }
              if (!hasFocusVariant) {
                if (totalFindings < maxFindings) {
                  findings['wcag-focus-indicator'].push({
                    id: nodeId,
                    name: nodeName,
                    issue: 'missing-variant',
                    suggestion: 'Add a focus/focused variant with a visible focus ring or outline'
                  });
                  totalFindings++;
                } else { truncated = true; }
              } else if (focusVariantNode) {
                // Check if focus variant has a visible stroke/border (focus ring)
                var focusStroke = lintGetNodeStrokeColor(focusVariantNode);
                var hasFocusEffect = false;
                try {
                  var effects = focusVariantNode.effects;
                  if (effects) {
                    for (var ei = 0; ei < effects.length; ei++) {
                      if (effects[ei].visible !== false && (effects[ei].type === 'DROP_SHADOW' || effects[ei].type === 'INNER_SHADOW')) {
                        hasFocusEffect = true;
                        break;
                      }
                    }
                  }
                } catch (e) { /* skip */ }
                if (!focusStroke && !hasFocusEffect) {
                  if (totalFindings < maxFindings) {
                    findings['wcag-focus-indicator'].push({
                      id: focusVariantNode.id,
                      name: nodeName + ' / ' + focusVariantNode.name,
                      issue: 'no-visible-indicator',
                      suggestion: 'Focus variant exists but has no visible border, outline, or shadow for the focus indicator'
                    });
                    totalFindings++;
                  } else { truncated = true; }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-letter-spacing: Negative letter spacing (WCAG 1.4.12)
        if (activeRuleSet['wcag-letter-spacing'] && nodeType === 'TEXT' && !truncated) {
          try {
            var ls = node.letterSpacing;
            if (ls && typeof ls === 'object' && typeof ls.value === 'number') {
              if (ls.unit === 'PIXELS' && ls.value < 0) {
                if (totalFindings < maxFindings) {
                  findings['wcag-letter-spacing'].push({
                    id: nodeId,
                    name: nodeName,
                    letterSpacing: ls.value + 'px'
                  });
                  totalFindings++;
                } else { truncated = true; }
              } else if (ls.unit === 'PERCENT' && ls.value < 0) {
                if (totalFindings < maxFindings) {
                  findings['wcag-letter-spacing'].push({
                    id: nodeId,
                    name: nodeName,
                    letterSpacing: ls.value + '%'
                  });
                  totalFindings++;
                } else { truncated = true; }
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-paragraph-spacing: Paragraph spacing < 2x font size (WCAG 1.4.12)
        if (activeRuleSet['wcag-paragraph-spacing'] && nodeType === 'TEXT' && !truncated) {
          try {
            var ps = node.paragraphSpacing;
            var psFs = node.fontSize;
            if (typeof ps === 'number' && typeof psFs === 'number' && ps > 0) {
              var requiredPs = 2 * psFs;
              if (ps < requiredPs && textHasMultipleParagraphs(node)) {
                if (totalFindings < maxFindings) {
                  findings['wcag-paragraph-spacing'].push({
                    id: nodeId,
                    name: nodeName,
                    paragraphSpacing: ps,
                    fontSize: psFs,
                    recommended: requiredPs
                  });
                  totalFindings++;
                } else { truncated = true; }
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-image-alt: Image fills without description (WCAG 1.1.1)
        if (activeRuleSet['wcag-image-alt'] && !isPage && !isSection && !truncated) {
          try {
            var hasImageFill = false;
            var imgFills = node.fills;
            if (imgFills && imgFills.length > 0) {
              for (var ifi = 0; ifi < imgFills.length; ifi++) {
                if (imgFills[ifi].type === 'IMAGE' && imgFills[ifi].visible !== false) {
                  hasImageFill = true;
                  break;
                }
              }
            }
            if (hasImageFill) {
              var hasDescription = false;
              try {
                if (node.description && node.description.trim().length > 0) {
                  hasDescription = true;
                }
              } catch (e) { /* skip */ }
              // Also check if node name indicates decorative
              var isDecorative = false;
              try {
                var lowerName = nodeName.toLowerCase();
                if (lowerName === 'decorative' || lowerName === 'decoration' || lowerName.indexOf('decorative') !== -1) {
                  isDecorative = true;
                }
              } catch (e) { /* skip */ }
              if (!hasDescription && !isDecorative) {
                if (totalFindings < maxFindings) {
                  findings['wcag-image-alt'].push({
                    id: nodeId,
                    name: nodeName,
                    suggestion: 'Add a description in the node\'s description field, or name it "decorative" if purely presentational'
                  });
                  totalFindings++;
                } else { truncated = true; }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-heading-hierarchy: Track heading levels for hierarchy check (WCAG 1.3.1)
        if (activeRuleSet['wcag-heading-hierarchy'] && nodeType === 'TEXT' && !truncated) {
          try {
            var hlevel = lintGetHeadingLevel(node);
            if (hlevel > 0) {
              headingSequence.push({ level: hlevel, id: nodeId, name: nodeName });
            }
          } catch (e) { /* skip */ }
        }

        // wcag-reflow: Fixed-position frames without auto-layout (WCAG 1.4.10)
        if (activeRuleSet['wcag-reflow'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT') && node.children && node.children.length >= 3) {
              var rlLayoutMode = 'NONE';
              try { rlLayoutMode = node.layoutMode; } catch (e) { /* skip */ }
              if (!rlLayoutMode || rlLayoutMode === 'NONE') {
                // Check if children use absolute positioning (different x/y values)
                var hasAbsoluteChildren = false;
                var childXs = [];
                var childYs = [];
                for (var rci = 0; rci < Math.min(node.children.length, 10); rci++) {
                  try {
                    childXs.push(node.children[rci].x);
                    childYs.push(node.children[rci].y);
                  } catch (e) { /* skip */ }
                }
                if (childXs.length >= 3) {
                  // If children are spread across both axes, it's likely absolute positioning
                  var uniqueXs = [];
                  var uniqueYs = [];
                  for (var uxi = 0; uxi < childXs.length; uxi++) {
                    if (uniqueXs.indexOf(childXs[uxi]) === -1) uniqueXs.push(childXs[uxi]);
                    if (uniqueYs.indexOf(childYs[uxi]) === -1) uniqueYs.push(childYs[uxi]);
                  }
                  hasAbsoluteChildren = uniqueXs.length > 2 && uniqueYs.length > 2;
                }
                if (hasAbsoluteChildren) {
                  if (totalFindings < maxFindings) {
                    findings['wcag-reflow'].push({
                      id: nodeId,
                      name: nodeName,
                      childCount: node.children.length,
                      suggestion: 'Convert to auto-layout so content can reflow at different viewport sizes'
                    });
                    totalFindings++;
                  } else { truncated = true; }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-reading-order: Check if visual order matches layer order (WCAG 1.3.2)
        if (activeRuleSet['wcag-reading-order'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE') && node.children && node.children.length >= 2) {
              var roLayoutMode = 'NONE';
              try { roLayoutMode = node.layoutMode; } catch (e) { /* skip */ }
              // Only check non-auto-layout frames (auto-layout enforces order)
              if (!roLayoutMode || roLayoutMode === 'NONE') {
                // Collect children y positions (for vertical reading order)
                var childPositions = [];
                for (var roi = 0; roi < node.children.length; roi++) {
                  try {
                    childPositions.push({
                      index: roi,
                      y: node.children[roi].y,
                      x: node.children[roi].x,
                      name: node.children[roi].name
                    });
                  } catch (e) { /* skip */ }
                }
                if (childPositions.length >= 2) {
                  // Sort by visual position (top-to-bottom, left-to-right)
                  var visualOrder = childPositions.slice().sort(function(a, b) {
                    if (Math.abs(a.y - b.y) > 10) return a.y - b.y; // Different row
                    return a.x - b.x; // Same row, left to right
                  });
                  // Check if layer order matches visual order
                  var orderMismatches = 0;
                  for (var omi = 0; omi < visualOrder.length; omi++) {
                    if (visualOrder[omi].index !== omi) {
                      orderMismatches++;
                    }
                  }
                  // Flag if more than 30% of elements are out of order
                  if (orderMismatches > childPositions.length * 0.3 && orderMismatches >= 2) {
                    if (totalFindings < maxFindings) {
                      findings['wcag-reading-order'].push({
                        id: nodeId,
                        name: nodeName,
                        childCount: childPositions.length,
                        mismatches: orderMismatches,
                        suggestion: 'Reorder layers to match visual top-to-bottom, left-to-right reading order'
                      });
                      totalFindings++;
                    } else { truncated = true; }
                  }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-disabled-no-context: Disabled variant without tooltip/helper text (Isabella's pattern)
        if (activeRuleSet['wcag-disabled-no-context'] && nodeType === 'COMPONENT_SET' && !truncated) {
          try {
            var csChildren = node.children;
            if (csChildren) {
              for (var dci = 0; dci < csChildren.length && !truncated; dci++) {
                var dcVariant = csChildren[dci];
                try {
                  var dcName = dcVariant.name || '';
                  if (/(disabled|inactive)/i.test(dcName)) {
                    // Check if disabled variant has tooltip, helper text, or descriptive child
                    var hasContextChild = false;
                    try {
                      if (dcVariant.children) {
                        for (var dcci = 0; dcci < dcVariant.children.length; dcci++) {
                          var dcChild = dcVariant.children[dcci];
                          try {
                            var dcChildName = (dcChild.name || '').toLowerCase();
                            // Look for tooltip, helper text, hint, description, or error message children
                            if (/tooltip|helper|hint|description|message|caption|note|info|why|reason/i.test(dcChildName)) {
                              hasContextChild = true;
                              break;
                            }
                            // Recurse one level for nested tooltip/helper
                            if (dcChild.children) {
                              for (var dcgci = 0; dcgci < dcChild.children.length; dcgci++) {
                                var dcGrandchild = dcChild.children[dcgci];
                                try {
                                  if (/tooltip|helper|hint|description|message/i.test(dcGrandchild.name || '')) {
                                    hasContextChild = true;
                                    break;
                                  }
                                } catch (e) { /* skip */ }
                              }
                              if (hasContextChild) break;
                            }
                          } catch (e) { /* skip */ }
                        }
                      }
                    } catch (e) { /* skip */ }
                    // Also check component description for disabled guidance
                    var hasDisabledAnnotation = false;
                    try {
                      var csDesc = (node.description || '').toLowerCase();
                      if (/disabled.*tooltip|disabled.*helper|disabled.*hint|aria-disabled|why.*disabled|disabled.*reason/i.test(csDesc)) {
                        hasDisabledAnnotation = true;
                      }
                    } catch (e) { /* skip */ }
                    if (!hasContextChild && !hasDisabledAnnotation) {
                      if (totalFindings < maxFindings) {
                        findings['wcag-disabled-no-context'].push({
                          id: dcVariant.id,
                          name: nodeName + ' / ' + dcVariant.name,
                          suggestion: 'Disabled elements should remain focusable (use aria-disabled, not HTML disabled). Add a tooltip or helper text explaining why the element is disabled so screen reader users understand the context.'
                        });
                        totalFindings++;
                      } else { truncated = true; }
                    }
                  }
                } catch (e) { /* skip variant */ }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // ---- Design System checks ----

        // token-misuse: Variable name prefix doesn't match usage context
        if (activeRuleSet['token-misuse'] && !isPage && !isSection && !truncated) {
          try {
            var tmFills = node.fills;
            if (tmFills && tmFills.length > 0) {
              for (var tmi = 0; tmi < tmFills.length; tmi++) {
                var tmFill = tmFills[tmi];
                if (tmFill.type === 'SOLID' && tmFill.visible !== false) {
                  try {
                    if (tmFill.boundVariables && tmFill.boundVariables.color) {
                      var tmVarId = tmFill.boundVariables.color.id;
                      // Resolve variable name
                      try {
                        var tmVar = figma.variables.getVariableById(tmVarId);
                        if (tmVar) {
                          var tmVarName = tmVar.name.toLowerCase();
                          var isBgToken = /^(bg|background|surface|fill)[\/-]/.test(tmVarName);
                          var isTextNode = nodeType === 'TEXT';
                          // Flag: bg/surface token used as text fill
                          if (isTextNode && isBgToken) {
                            if (totalFindings < maxFindings) {
                              findings['token-misuse'].push({
                                id: nodeId,
                                name: nodeName,
                                variable: tmVar.name,
                                usage: 'text fill',
                                expectedPrefix: 'text/*, fg/*, foreground/*',
                                suggestion: 'This text node uses a background/surface token ("' + tmVar.name + '") as its fill color. This is likely a misbound token — use a text/foreground token instead.'
                              });
                              totalFindings++;
                            } else { truncated = true; }
                          }
                          // Flag: text/foreground token used as frame/shape background
                          var isTextToken = /^(text|fg|foreground|font)[\/-]/.test(tmVarName);
                          var isContainerNode = nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' || nodeType === 'RECTANGLE';
                          if (isContainerNode && isTextToken && !truncated) {
                            if (totalFindings < maxFindings) {
                              findings['token-misuse'].push({
                                id: nodeId,
                                name: nodeName,
                                variable: tmVar.name,
                                usage: 'background fill',
                                expectedPrefix: 'bg/*, background/*, surface/*',
                                suggestion: 'This container uses a text/foreground token ("' + tmVar.name + '") as its background fill. This is likely a misbound token — use a background/surface token instead.'
                              });
                              totalFindings++;
                            } else { truncated = true; }
                          }
                        }
                      } catch (e) { /* can't resolve variable */ }
                    }
                  } catch (e) { /* no bound vars */ }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // hardcoded-color: Solid fills without variable binding or style
        if (activeRuleSet['hardcoded-color'] && !isPage && !isSection && !truncated) {
          try {
            var hcFills = node.fills;
            if (hcFills && hcFills.length > 0) {
              var hasFillStyle = false;
              try {
                hasFillStyle = node.fillStyleId && node.fillStyleId !== '';
              } catch (e) { /* mixed fill styles */ }

              if (!hasFillStyle) {
                for (var hci = 0; hci < hcFills.length; hci++) {
                  var hcFill = hcFills[hci];
                  if (hcFill.type === 'SOLID' && hcFill.visible !== false) {
                    var hasBoundVar = false;
                    try {
                      if (hcFill.boundVariables && hcFill.boundVariables.color) {
                        hasBoundVar = true;
                      }
                    } catch (e) { /* no bound vars */ }

                    if (!hasBoundVar) {
                      if (totalFindings < maxFindings) {
                        findings['hardcoded-color'].push({
                          id: nodeId,
                          name: nodeName,
                          color: lintRgbToHex(hcFill.color.r, hcFill.color.g, hcFill.color.b)
                        });
                        totalFindings++;
                      } else {
                        truncated = true;
                      }
                      break; // One finding per node
                    }
                  }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // no-text-style: TEXT nodes without textStyleId
        if (activeRuleSet['no-text-style'] && nodeType === 'TEXT' && !truncated) {
          try {
            var hasTextStyle = node.textStyleId && node.textStyleId !== '';
            if (!hasTextStyle) {
              if (totalFindings < maxFindings) {
                findings['no-text-style'].push({
                  id: nodeId,
                  name: nodeName
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // default-name: Nodes with default Figma names
        if (activeRuleSet['default-name'] && !isPage && !truncated) {
          try {
            if (defaultNameRegex.test(nodeName)) {
              if (totalFindings < maxFindings) {
                findings['default-name'].push({
                  id: nodeId,
                  name: nodeName,
                  type: nodeType
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // detached-component: Frames with "/" in name but not component/instance
        if (activeRuleSet['detached-component'] && nodeType === 'FRAME' && !truncated) {
          try {
            if (nodeName.indexOf('/') !== -1) {
              if (totalFindings < maxFindings) {
                findings['detached-component'].push({
                  id: nodeId,
                  name: nodeName
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // ---- Layout checks ----

        // no-autolayout: Frames with 2+ children and no auto-layout
        if (activeRuleSet['no-autolayout'] && !isPage && !isSection && !truncated) {
          try {
            if (nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'COMPONENT_SET') {
              var childCount = 0;
              try { childCount = node.children ? node.children.length : 0; } catch (e) { /* skip */ }
              if (childCount >= 2) {
                var layoutMode = 'NONE';
                try { layoutMode = node.layoutMode; } catch (e) { /* skip */ }
                if (!layoutMode || layoutMode === 'NONE') {
                  if (totalFindings < maxFindings) {
                    findings['no-autolayout'].push({
                      id: nodeId,
                      name: nodeName,
                      childCount: childCount
                    });
                    totalFindings++;
                  } else {
                    truncated = true;
                  }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // empty-container: Frames with zero children
        if (activeRuleSet['empty-container'] && !isPage && !isSection && !truncated) {
          try {
            if (nodeType === 'FRAME') {
              var ec = 0;
              try { ec = node.children ? node.children.length : 0; } catch (e) { /* skip */ }
              if (ec === 0) {
                if (totalFindings < maxFindings) {
                  findings['empty-container'].push({
                    id: nodeId,
                    name: nodeName
                  });
                  totalFindings++;
                } else {
                  truncated = true;
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // ---- Recurse into children ----
        try {
          if (node.children) {
            for (var ci = 0; ci < node.children.length; ci++) {
              if (truncated) break;
              walkNode(node.children[ci], depth + 1);
            }
          }
        } catch (e) { /* no children or slot sublayer */ }
      }

      // ---- Execute walk ----
      walkNode(rootNode, 0);

      // ---- Post-walk: heading hierarchy validation ----
      if (activeRuleSet['wcag-heading-hierarchy'] && headingSequence.length >= 2 && !truncated) {
        var prevLevel = 0;
        for (var hi = 0; hi < headingSequence.length; hi++) {
          var h = headingSequence[hi];
          if (prevLevel > 0 && h.level > prevLevel + 1) {
            // Skipped a level (e.g., H1 → H3)
            if (totalFindings < maxFindings) {
              findings['wcag-heading-hierarchy'].push({
                id: h.id,
                name: h.name,
                level: h.level,
                previousLevel: prevLevel,
                suggestion: 'Expected H' + (prevLevel + 1) + ' but found H' + h.level + '. Do not skip heading levels.'
              });
              totalFindings++;
            } else {
              truncated = true;
              break;
            }
          }
          prevLevel = h.level;
        }
      }

      // ---- Build response ----
      var categories = [];
      var summaryObj = { critical: 0, warning: 0, info: 0, total: 0 };

      for (var rk = 0; rk < allRuleIds.length; rk++) {
        var ruleId = allRuleIds[rk];
        if (!findings[ruleId] || findings[ruleId].length === 0) continue;
        var sev = severityMap[ruleId];
        categories.push({
          rule: ruleId,
          severity: sev,
          wcagLevel: wcagLevelMap[ruleId] || null,
          count: findings[ruleId].length,
          description: ruleDescriptions[ruleId],
          nodes: findings[ruleId]
        });
        summaryObj[sev] = (summaryObj[sev] || 0) + findings[ruleId].length;
        summaryObj.total += findings[ruleId].length;
      }

      var responseData = {
        rootNodeId: rootNode.id,
        rootNodeName: rootNode.name,
        nodesScanned: nodesScanned,
        categories: categories,
        summary: summaryObj
      };

      if (truncated) {
        responseData.warning = 'Showing first ' + maxFindings + ' findings...';
      }

      console.log('🌉 [Desktop Bridge] Lint complete: ' + summaryObj.total + ' findings across ' + nodesScanned + ' nodes');

      figma.ui.postMessage({
        type: 'LINT_DESIGN_RESULT',
        requestId: msg.requestId,
        success: true,
        data: responseData
      });

    } catch (error) {
      var errorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Lint design error:', errorMsg);
      figma.ui.postMessage({
        type: 'LINT_DESIGN_RESULT',
        requestId: msg.requestId,
        success: false,
        error: errorMsg
      });
    }
  }

  // ============================================================================
  // AUDIT_COMPONENT_ACCESSIBILITY — Deep accessibility audit for a component set
  // ============================================================================
  else if (msg.type === 'AUDIT_COMPONENT_ACCESSIBILITY') {
    try {
      console.log('🌉 [Desktop Bridge] Running component accessibility audit...');

      // ---- Color science helpers (shared with lint) ----
      function auditLinearize(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }
      function auditLuminance(r, g, b) {
        return 0.2126 * auditLinearize(r) + 0.7152 * auditLinearize(g) + 0.0722 * auditLinearize(b);
      }
      function auditContrastRatio(r1, g1, b1, r2, g2, b2) {
        var l1 = auditLuminance(r1, g1, b1);
        var l2 = auditLuminance(r2, g2, b2);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      function auditRgbToHex(r, g, b) {
        var rr = Math.round(r * 255).toString(16);
        var gg = Math.round(g * 255).toString(16);
        var bb = Math.round(b * 255).toString(16);
        if (rr.length === 1) rr = '0' + rr;
        if (gg.length === 1) gg = '0' + gg;
        if (bb.length === 1) bb = '0' + bb;
        return '#' + rr.toUpperCase() + gg.toUpperCase() + bb.toUpperCase();
      }

      // ---- Color-blind simulation matrices ----
      // Brettel/Vienot transformation matrices for dichromatic vision
      var colorBlindMatrices = {
        protanopia: [
          [0.152286, 1.052583, -0.204868],
          [0.114503, 0.786281, 0.099216],
          [-0.003882, -0.048116, 1.051998]
        ],
        deuteranopia: [
          [0.367322, 0.860646, -0.227968],
          [0.280085, 0.672501, 0.047413],
          [-0.011820, 0.042940, 0.968881]
        ],
        tritanopia: [
          [1.255528, -0.076749, -0.178779],
          [-0.078411, 0.930809, 0.147602],
          [0.004733, 0.691367, 0.303900]
        ]
      };

      function simulateColorBlind(r, g, b, matrix) {
        var nr = Math.max(0, Math.min(1, matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b));
        var ng = Math.max(0, Math.min(1, matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b));
        var nb = Math.max(0, Math.min(1, matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b));
        return { r: nr, g: ng, b: nb };
      }

      // ---- Node inspection helpers ----
      function auditGetFillColor(node) {
        try {
          var fills = node.fills;
          if (fills && fills.length > 0) {
            for (var i = fills.length - 1; i >= 0; i--) {
              if (fills[i].type === 'SOLID' && fills[i].visible !== false) {
                return { r: fills[i].color.r, g: fills[i].color.g, b: fills[i].color.b };
              }
            }
          }
        } catch (e) { /* skip */ }
        return null;
      }

      function auditGetStrokeColor(node) {
        try {
          var strokes = node.strokes;
          if (strokes && strokes.length > 0) {
            for (var i = strokes.length - 1; i >= 0; i--) {
              if (strokes[i].type === 'SOLID' && strokes[i].visible !== false) {
                return { r: strokes[i].color.r, g: strokes[i].color.g, b: strokes[i].color.b };
              }
            }
          }
        } catch (e) { /* skip */ }
        return null;
      }

      function auditGetEffectiveBg(node) {
        var current = node.parent;
        while (current) {
          try {
            if (current.fills && current.fills.length > 0) {
              for (var fi = current.fills.length - 1; fi >= 0; fi--) {
                var fill = current.fills[fi];
                if (fill.type === 'SOLID' && fill.visible !== false) {
                  return { r: fill.color.r, g: fill.color.g, b: fill.color.b };
                }
              }
            }
          } catch (e) { /* skip */ }
          current = current.parent;
        }
        return { r: 1, g: 1, b: 1 };
      }

      function auditHasChildOfType(node, types) {
        try {
          if (!node.children) return false;
          for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            try {
              for (var t = 0; t < types.length; t++) {
                if (child.type === types[t]) return true;
              }
              // Recurse one level deeper for nested icons
              if (child.children) {
                for (var j = 0; j < child.children.length; j++) {
                  try {
                    for (var t2 = 0; t2 < types.length; t2++) {
                      if (child.children[j].type === types[t2]) return true;
                    }
                  } catch (e) { /* skip */ }
                }
              }
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* skip */ }
        return false;
      }

      // Collect all text fill colors and background colors from a variant tree
      function auditCollectColorPairs(node, pairs, depth) {
        if (depth > 5) return;
        try {
          if (node.type === 'TEXT') {
            var fills = node.fills;
            if (fills && fills.length > 0) {
              for (var i = 0; i < fills.length; i++) {
                if (fills[i].type === 'SOLID' && fills[i].visible !== false) {
                  var bg = auditGetEffectiveBg(node);
                  pairs.push({
                    fg: { r: fills[i].color.r, g: fills[i].color.g, b: fills[i].color.b },
                    bg: bg,
                    nodeName: node.name,
                    nodeId: node.id
                  });
                  break;
                }
              }
            }
          }
          if (node.children) {
            for (var ci = 0; ci < node.children.length; ci++) {
              auditCollectColorPairs(node.children[ci], pairs, depth + 1);
            }
          }
        } catch (e) { /* skip */ }
      }

      // ---- Resolve target node ----
      var targetNode;
      if (msg.nodeId) {
        targetNode = await figma.getNodeByIdAsync(msg.nodeId);
        if (!targetNode) {
          throw new Error('Node not found: ' + msg.nodeId);
        }
      } else {
        // Try current selection
        var sel = figma.currentPage.selection;
        if (sel && sel.length === 1) {
          targetNode = sel[0];
        } else {
          throw new Error('No nodeId provided and no single node selected. Select a component set or provide a nodeId.');
        }
      }

      // If user selected a COMPONENT or INSTANCE, walk up to the COMPONENT_SET
      var componentSet = targetNode;
      if (targetNode.type === 'COMPONENT' && targetNode.parent && targetNode.parent.type === 'COMPONENT_SET') {
        componentSet = targetNode.parent;
      } else if (targetNode.type === 'INSTANCE') {
        try {
          var mainComponent = await targetNode.getMainComponentAsync();
          if (mainComponent && mainComponent.parent && mainComponent.parent.type === 'COMPONENT_SET') {
            componentSet = mainComponent.parent;
          } else if (mainComponent && mainComponent.type === 'COMPONENT') {
            componentSet = mainComponent;
          }
        } catch (e) { /* use target as-is */ }
      }

      var isComponentSet = componentSet.type === 'COMPONENT_SET';
      var isComponent = componentSet.type === 'COMPONENT';
      if (!isComponentSet && !isComponent) {
        throw new Error('Node "' + componentSet.name + '" is type ' + componentSet.type + '. Expected COMPONENT_SET or COMPONENT.');
      }

      // ---- Analyze variants ----
      var variants = isComponentSet ? componentSet.children : [componentSet];
      var variantCount = variants.length;

      // ---- Classify component as interactive vs presentational ----
      var interactiveNames = /^(button|link|input|checkbox|radio|switch|toggle|tab|select|slider|dropdown|menu-item|search|combobox|listbox)/i;
      var presentationalNames = /^(alert|badge|card|avatar|divider|skeleton|tooltip|tag|chip|banner|callout|notification|toast|icon|image|separator|progress|spinner|loader|breadcrumb|label|heading|paragraph|caption|stat|meter|indicator)/i;

      // Parse variant axes from variant names (e.g., "type=success, style=fill" → {type: [...], style: [...]})
      var variantAxes = {};
      var hasStateAxis = false;
      for (var vai = 0; vai < variants.length; vai++) {
        var vParts = variants[vai].name.split(',');
        for (var vpi = 0; vpi < vParts.length; vpi++) {
          var kv = vParts[vpi].trim().split('=');
          if (kv.length === 2) {
            var axisName = kv[0].trim().toLowerCase();
            var axisValue = kv[1].trim().toLowerCase();
            if (!variantAxes[axisName]) variantAxes[axisName] = [];
            if (variantAxes[axisName].indexOf(axisValue) === -1) {
              variantAxes[axisName].push(axisValue);
            }
            // Check if this axis contains interaction state values
            if (axisName === 'state' && /(hover|focus|pressed|disabled|active)/i.test(axisValue)) {
              hasStateAxis = true;
            }
          }
        }
      }

      var componentName = componentSet.name || '';
      var isInteractive = interactiveNames.test(componentName) || hasStateAxis;
      var isPresentational = !isInteractive && (presentationalNames.test(componentName) || !hasStateAxis);
      // If ambiguous, check if any variant mentions interaction states
      if (!isInteractive && !isPresentational) {
        for (var ami = 0; ami < variants.length; ami++) {
          if (/(hover|focus|pressed|disabled)/i.test(variants[ami].name)) {
            isInteractive = true;
            break;
          }
        }
        if (!isInteractive) isPresentational = true;
      }

      // 1. Coverage analysis — adapts to component classification
      var stateKeywords = {
        'default': /(default|rest|idle|normal|base)/i,
        'hover': /(hover|hovered)/i,
        'focus': /(focus|focused)/i,
        'disabled': /(disabled|inactive)/i,
        'error': /(error|invalid|danger)/i,
        'active': /(active|pressed|selected)/i,
        'loading': /(loading|spinner)/i
      };

      var coveredCount = 0;
      var totalStates = 0;
      var missingStates = [];
      var statesCovered = {};
      var statesFound = {};
      var coverageLabel = '';
      var variantAxisCoverage = null;

      if (isInteractive) {
        // Interactive components: check for interaction states
        coverageLabel = 'interactive-states';
        for (var sk in stateKeywords) {
          statesCovered[sk] = false;
          statesFound[sk] = null;
        }
        for (var vi = 0; vi < variants.length; vi++) {
          var vName = variants[vi].name;
          for (var sk2 in stateKeywords) {
            if (stateKeywords[sk2].test(vName)) {
              statesCovered[sk2] = true;
              if (!statesFound[sk2]) statesFound[sk2] = vName;
            }
          }
        }
        if (variantCount === 1 && !statesCovered['default']) {
          statesCovered['default'] = true;
          statesFound['default'] = variants[0].name;
        }
        for (var sk3 in statesCovered) {
          totalStates++;
          if (statesCovered[sk3]) {
            coveredCount++;
          } else {
            missingStates.push(sk3);
          }
        }
      } else {
        // Presentational components: check variant axis completeness
        coverageLabel = 'variant-axes';
        // Calculate expected combinations vs actual
        var axisNames = [];
        var axisCounts = [];
        var expectedCombinations = 1;
        for (var axName in variantAxes) {
          axisNames.push(axName);
          axisCounts.push(variantAxes[axName].length);
          expectedCombinations *= variantAxes[axName].length;
        }
        // Score: actual variants / expected combinations (capped at 100%)
        var axisCoverageRatio = expectedCombinations > 0 ? Math.min(1, variantCount / expectedCombinations) : 1;
        coveredCount = variantCount;
        totalStates = expectedCombinations;
        variantAxisCoverage = {
          axes: variantAxes,
          axisCount: axisNames.length,
          expectedCombinations: expectedCombinations,
          actualVariants: variantCount,
          completeness: Math.round(axisCoverageRatio * 100) + '%'
        };
        // For presentational, no "missing states" — instead note if combinations are incomplete
        if (variantCount < expectedCombinations) {
          missingStates.push(variantCount + '/' + expectedCombinations + ' axis combinations present');
        }
      }

      // 2. Focus indicator quality
      var focusAnalysis = { hasVariant: false, hasVisibleIndicator: false, contrastRatio: null, details: '' };
      if (statesCovered['focus'] && isComponentSet) {
        focusAnalysis.hasVariant = true;
        for (var fvi = 0; fvi < variants.length; fvi++) {
          if (/(focus|focused)/i.test(variants[fvi].name)) {
            var focusNode = variants[fvi];
            // Check for stroke (focus ring)
            var fStroke = auditGetStrokeColor(focusNode);
            if (fStroke) {
              var fBg = auditGetEffectiveBg(focusNode);
              var fRatio = auditContrastRatio(fStroke.r, fStroke.g, fStroke.b, fBg.r, fBg.g, fBg.b);
              focusAnalysis.hasVisibleIndicator = true;
              focusAnalysis.contrastRatio = parseFloat(fRatio.toFixed(1));
              focusAnalysis.details = 'Focus ring (stroke) with ' + fRatio.toFixed(1) + ':1 contrast';
              break;
            }
            // Check for shadow effect
            try {
              var effects = focusNode.effects;
              if (effects) {
                for (var ei = 0; ei < effects.length; ei++) {
                  if (effects[ei].visible !== false && (effects[ei].type === 'DROP_SHADOW' || effects[ei].type === 'INNER_SHADOW')) {
                    focusAnalysis.hasVisibleIndicator = true;
                    focusAnalysis.details = 'Focus indicator via ' + effects[ei].type.toLowerCase().replace('_', ' ');
                    break;
                  }
                }
              }
            } catch (e) { /* skip */ }
            if (!focusAnalysis.hasVisibleIndicator) {
              focusAnalysis.details = 'Focus variant exists but no visible stroke or shadow detected';
            }
            break;
          }
        }
      } else if (!statesCovered['focus']) {
        focusAnalysis.details = 'No focus/focused variant found';
      }

      // 3. Non-color differentiation for status states
      var colorDifferentiation = { issues: [], checked: 0 };
      if (isComponentSet) {
        var statusStates = ['error', 'disabled', 'active'];
        var defaultVariant = null;
        for (var dvi = 0; dvi < variants.length; dvi++) {
          if (/(default|rest|idle|normal|base)/i.test(variants[dvi].name) || dvi === 0) {
            defaultVariant = variants[dvi];
            break;
          }
        }
        for (var ssi = 0; ssi < statusStates.length; ssi++) {
          var stateName = statusStates[ssi];
          if (statesCovered[stateName]) {
            colorDifferentiation.checked++;
            for (var svi = 0; svi < variants.length; svi++) {
              if (stateKeywords[stateName].test(variants[svi].name)) {
                var stateVariant = variants[svi];
                var stateFill = auditGetFillColor(stateVariant);
                var defaultFill = defaultVariant ? auditGetFillColor(defaultVariant) : null;
                var hasIcon = auditHasChildOfType(stateVariant, ['VECTOR', 'BOOLEAN_OPERATION', 'INSTANCE']);
                var hasStroke = auditGetStrokeColor(stateVariant) !== null;
                var colorDiffers = stateFill && defaultFill && (stateFill.r !== defaultFill.r || stateFill.g !== defaultFill.g || stateFill.b !== defaultFill.b);
                if (colorDiffers && !hasIcon && !hasStroke) {
                  colorDifferentiation.issues.push({
                    variant: stateVariant.name,
                    state: stateName,
                    variantColor: stateFill ? auditRgbToHex(stateFill.r, stateFill.g, stateFill.b) : null,
                    defaultColor: defaultFill ? auditRgbToHex(defaultFill.r, defaultFill.g, defaultFill.b) : null,
                    suggestion: 'Add icon, border, or text indicator beyond color'
                  });
                }
                break;
              }
            }
          }
        }
      }

      // 4. Target size analysis
      // WCAG 2.5.8 applies to interactive targets — presentational components
      // (badges, avatars, progress bars) are not tap targets by definition.
      // Skip target size checking for presentational components to avoid false positives.
      var targetSizeAnalysis = { minWidth: Infinity, minHeight: Infinity, variants: [], issues: [] };
      var minTarget = msg.targetSize || 24; // Default WCAG 2.5.8 minimum
      for (var tvi = 0; tvi < variants.length; tvi++) {
        try {
          var tw = variants[tvi].width;
          var th = variants[tvi].height;
          if (typeof tw === 'number' && typeof th === 'number') {
            targetSizeAnalysis.variants.push({ name: variants[tvi].name, width: tw, height: th });
            if (tw < targetSizeAnalysis.minWidth) targetSizeAnalysis.minWidth = tw;
            if (th < targetSizeAnalysis.minHeight) targetSizeAnalysis.minHeight = th;
            // Only flag target size issues for interactive components
            if (isInteractive && (tw < minTarget || th < minTarget)) {
              targetSizeAnalysis.issues.push({
                variant: variants[tvi].name,
                width: tw,
                height: th,
                required: minTarget + 'x' + minTarget
              });
            }
          }
        } catch (e) { /* skip */ }
      }
      if (targetSizeAnalysis.minWidth === Infinity) targetSizeAnalysis.minWidth = null;
      if (targetSizeAnalysis.minHeight === Infinity) targetSizeAnalysis.minHeight = null;

      // 5. Annotation completeness
      var annotations = { hasDescription: false, description: '', hasA11yNotes: false, a11yNotes: '' };
      try {
        var desc = componentSet.description || '';
        if (desc.trim().length > 0) {
          annotations.hasDescription = true;
          annotations.description = desc.substring(0, 200);
        }
        if (/aria|accessibility|a11y|screen.?reader|keyboard|role|tab.?order/i.test(desc)) {
          annotations.hasA11yNotes = true;
          // Extract just the a11y-relevant section
          var lines = desc.split('\n');
          var a11yLines = [];
          for (var ali = 0; ali < lines.length; ali++) {
            if (/aria|accessibility|a11y|screen.?reader|keyboard|role|tab.?order/i.test(lines[ali])) {
              a11yLines.push(lines[ali].trim());
            }
          }
          annotations.a11yNotes = a11yLines.join('; ').substring(0, 300);
        }
      } catch (e) { /* skip */ }

      // 6. Color-blind simulation
      var colorBlindAnalysis = { simulations: [], issues: [] };
      // Collect all text/bg color pairs from the default variant (or first variant)
      var sampleVariant = defaultVariant || variants[0];
      var colorPairs = [];
      auditCollectColorPairs(sampleVariant, colorPairs, 0);

      // Also check component fill against its background
      var compFill = auditGetFillColor(sampleVariant);
      var compBg = auditGetEffectiveBg(sampleVariant);
      if (compFill) {
        colorPairs.push({ fg: compFill, bg: compBg, nodeName: sampleVariant.name + ' (fill)', nodeId: sampleVariant.id });
      }

      var cbTypes = ['protanopia', 'deuteranopia', 'tritanopia'];
      for (var cbi = 0; cbi < cbTypes.length; cbi++) {
        var cbType = cbTypes[cbi];
        var matrix = colorBlindMatrices[cbType];
        var failingPairs = [];
        for (var cpi = 0; cpi < Math.min(colorPairs.length, 20); cpi++) {
          var pair = colorPairs[cpi];
          var simFg = simulateColorBlind(pair.fg.r, pair.fg.g, pair.fg.b, matrix);
          var simBg = simulateColorBlind(pair.bg.r, pair.bg.g, pair.bg.b, matrix);
          var originalRatio = auditContrastRatio(pair.fg.r, pair.fg.g, pair.fg.b, pair.bg.r, pair.bg.g, pair.bg.b);
          var simRatio = auditContrastRatio(simFg.r, simFg.g, simFg.b, simBg.r, simBg.g, simBg.b);
          // Flag if simulated contrast drops below 4.5:1 (AA) when original was passing
          if (originalRatio >= 4.5 && simRatio < 4.5) {
            failingPairs.push({
              nodeName: pair.nodeName,
              originalRatio: parseFloat(originalRatio.toFixed(1)),
              simulatedRatio: parseFloat(simRatio.toFixed(1)),
              originalFg: auditRgbToHex(pair.fg.r, pair.fg.g, pair.fg.b),
              simulatedFg: auditRgbToHex(simFg.r, simFg.g, simFg.b)
            });
          }
          // Also flag if contrast drops significantly (>30% reduction) even if still passing
          if (originalRatio >= 4.5 && simRatio >= 4.5 && (simRatio / originalRatio) < 0.7) {
            failingPairs.push({
              nodeName: pair.nodeName,
              originalRatio: parseFloat(originalRatio.toFixed(1)),
              simulatedRatio: parseFloat(simRatio.toFixed(1)),
              originalFg: auditRgbToHex(pair.fg.r, pair.fg.g, pair.fg.b),
              simulatedFg: auditRgbToHex(simFg.r, simFg.g, simFg.b),
              note: 'Significant contrast reduction (>30%)'
            });
          }
        }
        colorBlindAnalysis.simulations.push({
          type: cbType,
          pairsChecked: Math.min(colorPairs.length, 20),
          issues: failingPairs.length,
          details: failingPairs
        });
        if (failingPairs.length > 0) {
          colorBlindAnalysis.issues.push(cbType + ': ' + failingPairs.length + ' color pair(s) lose sufficient contrast');
        }
      }

      // ---- Compute overall score ----
      var scores = {};
      // Coverage: percentage of states (interactive) or axis combinations (presentational)
      scores.variantCoverage = totalStates > 0 ? Math.round((coveredCount / totalStates) * 100) : 100;
      // Focus indicator: 0 (missing), 50 (exists but no indicator), 100 (good indicator)
      // For presentational: N/A → score 100 (don't penalize)
      scores.focusIndicator = isPresentational ? 100 : (!focusAnalysis.hasVariant ? 0 : (!focusAnalysis.hasVisibleIndicator ? 50 : 100));
      // Color differentiation: 100 if no issues, decremented per issue
      scores.colorDifferentiation = colorDifferentiation.checked === 0 ? 100 : Math.max(0, Math.round(((colorDifferentiation.checked - colorDifferentiation.issues.length) / colorDifferentiation.checked) * 100));
      // Target size: N/A for presentational (not tap targets), scored for interactive
      scores.targetSize = isPresentational ? 100 : (targetSizeAnalysis.issues.length === 0 ? 100 : Math.max(0, Math.round(((targetSizeAnalysis.variants.length - targetSizeAnalysis.issues.length) / Math.max(1, targetSizeAnalysis.variants.length)) * 100)));
      // Annotations: 0 (nothing), 50 (description only), 100 (has a11y notes)
      scores.annotations = annotations.hasA11yNotes ? 100 : (annotations.hasDescription ? 50 : 0);
      // Color blind: percentage of simulations with no issues
      var cbPassCount = 0;
      for (var cbsi = 0; cbsi < colorBlindAnalysis.simulations.length; cbsi++) {
        if (colorBlindAnalysis.simulations[cbsi].issues === 0) cbPassCount++;
      }
      scores.colorBlindSafety = colorBlindAnalysis.simulations.length > 0 ? Math.round((cbPassCount / colorBlindAnalysis.simulations.length) * 100) : 100;

      // Overall weighted score — weights differ by component classification
      var overall;
      if (isInteractive) {
        // Interactive: focus and states matter most
        overall = Math.round(
          scores.variantCoverage * 0.20 +
          scores.focusIndicator * 0.20 +
          scores.colorDifferentiation * 0.15 +
          scores.targetSize * 0.15 +
          scores.annotations * 0.10 +
          scores.colorBlindSafety * 0.20
        );
      } else {
        // Presentational: variant completeness and color safety matter most, focus is N/A
        overall = Math.round(
          scores.variantCoverage * 0.25 +
          scores.colorDifferentiation * 0.25 +
          scores.annotations * 0.15 +
          scores.colorBlindSafety * 0.25 +
          scores.targetSize * 0.10
        );
      }

      // ---- Build response ----
      var coverageSection;
      if (isInteractive) {
        coverageSection = {
          mode: 'interactive-states',
          found: statesFound,
          missing: missingStates,
          coverage: coveredCount + '/' + totalStates
        };
      } else {
        coverageSection = {
          mode: 'variant-axes',
          axes: variantAxisCoverage,
          coverage: coveredCount + '/' + totalStates
        };
      }

      var auditResult = {
        component: {
          id: componentSet.id,
          name: componentSet.name,
          type: componentSet.type,
          variantCount: variantCount,
          classification: isInteractive ? 'interactive' : 'presentational'
        },
        overallScore: overall,
        scores: scores,
        variantCoverage: coverageSection,
        focusIndicator: isInteractive ? focusAnalysis : { notApplicable: true, details: 'Focus indicators are not expected for presentational components' },
        colorDifferentiation: colorDifferentiation,
        targetSize: isInteractive ? {
          minimum: minTarget + 'x' + minTarget,
          smallest: targetSizeAnalysis.minWidth + 'x' + targetSizeAnalysis.minHeight,
          issues: targetSizeAnalysis.issues
        } : { notApplicable: true, details: 'Target size checks apply to interactive components (WCAG 2.5.8 is about tap targets)', smallest: targetSizeAnalysis.minWidth + 'x' + targetSizeAnalysis.minHeight },
        annotations: annotations,
        colorBlindSimulation: colorBlindAnalysis,
        recommendations: []
      };

      // Generate recommendations — classification-aware
      if (isInteractive) {
        if (!focusAnalysis.hasVariant) {
          auditResult.recommendations.push({ priority: 'high', area: 'focus', message: 'Add a focus/focused variant with a visible focus ring (WCAG 2.4.7)' });
        } else if (!focusAnalysis.hasVisibleIndicator) {
          auditResult.recommendations.push({ priority: 'medium', area: 'focus', message: 'Focus variant exists but lacks visible indicator — add a border or shadow' });
        }
      }
      if (colorDifferentiation.issues.length > 0) {
        auditResult.recommendations.push({ priority: 'high', area: 'color', message: 'Add non-color indicators (icons, borders, text) to ' + colorDifferentiation.issues.length + ' state variant(s) (WCAG 1.4.1)' });
      }
      if (targetSizeAnalysis.issues.length > 0) {
        auditResult.recommendations.push({ priority: 'high', area: 'target-size', message: targetSizeAnalysis.issues.length + ' variant(s) below ' + minTarget + 'x' + minTarget + 'px minimum target size (WCAG 2.5.8)' });
      }
      if (!annotations.hasDescription) {
        auditResult.recommendations.push({ priority: 'medium', area: 'documentation', message: 'Add a component description with usage guidelines' });
      }
      if (!annotations.hasA11yNotes) {
        var a11yHint = isInteractive
          ? 'Add accessibility notes (ARIA role, keyboard interactions, screen reader behavior)'
          : 'Add accessibility notes (ARIA role, live region behavior, semantic usage)';
        auditResult.recommendations.push({ priority: 'medium', area: 'documentation', message: a11yHint });
      }
      if (colorBlindAnalysis.issues.length > 0) {
        auditResult.recommendations.push({ priority: 'medium', area: 'color-blind', message: colorBlindAnalysis.issues.join('; ') });
      }
      if (isInteractive) {
        for (var msi = 0; msi < missingStates.length; msi++) {
          var ms = missingStates[msi];
          if (ms === 'focus' || ms === 'disabled') {
            auditResult.recommendations.push({ priority: 'medium', area: 'states', message: 'Consider adding a "' + ms + '" variant for complete interactive state coverage' });
          }
        }
      } else if (variantAxisCoverage && variantCount < variantAxisCoverage.expectedCombinations) {
        auditResult.recommendations.push({ priority: 'low', area: 'coverage', message: variantCount + ' of ' + variantAxisCoverage.expectedCombinations + ' axis combinations present — consider adding missing variants for completeness' });
      }

      console.log('🌉 [Desktop Bridge] Component audit complete: score ' + overall + '/100 for "' + componentSet.name + '"');

      figma.ui.postMessage({
        type: 'AUDIT_COMPONENT_ACCESSIBILITY_RESULT',
        requestId: msg.requestId,
        success: true,
        data: auditResult
      });

    } catch (error) {
      var auditErrorMsg = error && error.message ? error.message : String(error);
      console.error('🌉 [Desktop Bridge] Component accessibility audit error:', auditErrorMsg);
      figma.ui.postMessage({
        type: 'AUDIT_COMPONENT_ACCESSIBILITY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: auditErrorMsg
      });
    }
  }

  // ============================================================================
  // FIGJAM TOOLS — Only functional when editorType === 'figjam'
  // ============================================================================

  // CREATE_STICKY - Create a sticky note
  else if (msg.type === 'CREATE_STICKY') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_STICKY is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating sticky note');

      var sticky = figma.createSticky();
      await figma.loadFontAsync(sticky.text.fontName);
      sticky.text.characters = msg.text || '';

      if (typeof msg.x === 'number') sticky.x = msg.x;
      if (typeof msg.y === 'number') sticky.y = msg.y;

      // Set sticky color if provided
      if (msg.color) {
        var stickyColor = __stickyColors[msg.color.toUpperCase()];
        if (stickyColor) {
          sticky.fills = [{ type: 'SOLID', color: stickyColor }];
        }
      }

      figma.ui.postMessage({
        type: 'CREATE_STICKY_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: sticky.id, type: sticky.type, name: sticky.name, x: sticky.x, y: sticky.y }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create sticky error:', error);
      figma.ui.postMessage({
        type: 'CREATE_STICKY_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_STICKIES - Batch create sticky notes
  else if (msg.type === 'CREATE_STICKIES') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_STICKIES is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Batch creating sticky notes:', msg.stickies.length);

      var created = [];
      var failed = [];

      // Load font once for all stickies (they all share the same default font)
      var stickyFontLoaded = false;

      for (var si = 0; si < msg.stickies.length; si++) {
        try {
          var spec = msg.stickies[si];
          var sticky = figma.createSticky();
          if (!stickyFontLoaded) {
            await figma.loadFontAsync(sticky.text.fontName);
            stickyFontLoaded = true;
          }
          sticky.text.characters = spec.text || '';

          if (typeof spec.x === 'number') sticky.x = spec.x;
          if (typeof spec.y === 'number') sticky.y = spec.y;

          if (spec.color) {
            var sc = __stickyColors[spec.color.toUpperCase()];
            if (sc) {
              sticky.fills = [{ type: 'SOLID', color: sc }];
            }
          }

          created.push({ id: sticky.id, type: sticky.type, name: sticky.name, x: sticky.x, y: sticky.y });
        } catch (e) {
          failed.push({ index: si, error: e.message || String(e) });
        }
      }

      figma.ui.postMessage({
        type: 'CREATE_STICKIES_RESULT',
        requestId: msg.requestId,
        success: failed.length === 0,
        data: { created: created.length, failed: failed.length, results: created, errors: failed }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Batch create stickies error:', error);
      figma.ui.postMessage({
        type: 'CREATE_STICKIES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_CONNECTOR - Connect two nodes with a connector
  else if (msg.type === 'CREATE_CONNECTOR') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_CONNECTOR is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating connector');

      var connector = figma.createConnector();

      // Set start and end endpoints
      var startNode = await figma.getNodeByIdAsync(msg.startNodeId);
      var endNode = await figma.getNodeByIdAsync(msg.endNodeId);

      if (!startNode) throw new Error('Start node not found: ' + msg.startNodeId);
      if (!endNode) throw new Error('End node not found: ' + msg.endNodeId);

      connector.connectorStart = {
        endpointNodeId: msg.startNodeId,
        magnet: msg.startMagnet || 'AUTO'
      };
      connector.connectorEnd = {
        endpointNodeId: msg.endNodeId,
        magnet: msg.endMagnet || 'AUTO'
      };

      // Set label text if provided
      if (msg.label) {
        try {
          await figma.loadFontAsync(connector.text.fontName);
        } catch (e) {
          // Connector default font may not be loadable — fall back to Inter
          await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
          connector.text.fontName = { family: 'Inter', style: 'Medium' };
        }
        connector.text.characters = msg.label;
      }

      figma.ui.postMessage({
        type: 'CREATE_CONNECTOR_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: connector.id, type: connector.type, name: connector.name }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create connector error:', error);
      figma.ui.postMessage({
        type: 'CREATE_CONNECTOR_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_SECTION - Create a section on FigJam board
  else if (msg.type === 'CREATE_SECTION') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_SECTION is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating section');

      var section = figma.createSection();
      if (msg.name) section.name = msg.name;
      if (typeof msg.x === 'number') section.x = msg.x;
      if (typeof msg.y === 'number') section.y = msg.y;
      if (typeof msg.width === 'number' && typeof msg.height === 'number') {
        section.resizeWithoutConstraints(msg.width, msg.height);
      }
      if (msg.fillColor) {
        var scHex = msg.fillColor.replace('#', '');
        var scR = parseInt(scHex.substring(0, 2), 16) / 255;
        var scG = parseInt(scHex.substring(2, 4), 16) / 255;
        var scB = parseInt(scHex.substring(4, 6), 16) / 255;
        section.fills = [{ type: 'SOLID', color: { r: scR, g: scG, b: scB } }];
      }

      figma.ui.postMessage({
        type: 'CREATE_SECTION_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          id: section.id,
          type: section.type,
          name: section.name,
          x: section.x,
          y: section.y,
          width: section.width,
          height: section.height
        }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create section error:', error);
      figma.ui.postMessage({
        type: 'CREATE_SECTION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_SHAPE_WITH_TEXT - Create a labeled shape
  else if (msg.type === 'CREATE_SHAPE_WITH_TEXT') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_SHAPE_WITH_TEXT is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating shape with text');

      var shape = figma.createShapeWithText();

      // Set shape type if provided
      if (msg.shapeType) {
        shape.shapeType = msg.shapeType;
      }

      // Set position
      if (typeof msg.x === 'number') shape.x = msg.x;
      if (typeof msg.y === 'number') shape.y = msg.y;

      // Resize (before text so text reflows to fit)
      if (typeof msg.width === 'number' && typeof msg.height === 'number') {
        shape.resize(msg.width, msg.height);
      } else if (typeof msg.width === 'number') {
        shape.resize(msg.width, shape.height);
      } else if (typeof msg.height === 'number') {
        shape.resize(shape.width, msg.height);
      }

      // Fill color
      if (msg.fillColor) {
        var fHex = msg.fillColor.replace('#', '');
        var fR = parseInt(fHex.substring(0, 2), 16) / 255;
        var fG = parseInt(fHex.substring(2, 4), 16) / 255;
        var fB = parseInt(fHex.substring(4, 6), 16) / 255;
        shape.fills = [{ type: 'SOLID', color: { r: fR, g: fG, b: fB } }];
      }

      // Stroke color
      if (msg.strokeColor) {
        var sHex = msg.strokeColor.replace('#', '');
        var sR = parseInt(sHex.substring(0, 2), 16) / 255;
        var sG = parseInt(sHex.substring(2, 4), 16) / 255;
        var sB = parseInt(sHex.substring(4, 6), 16) / 255;
        shape.strokes = [{ type: 'SOLID', color: { r: sR, g: sG, b: sB } }];
        shape.strokeWeight = 1;
      }

      // Dash pattern
      if (msg.strokeDashPattern) {
        var parts = msg.strokeDashPattern.split(',').map(function(p) { return parseFloat(p.trim()); });
        shape.dashPattern = parts;
      }

      // Set text (after resize so text reflows to fit new size)
      if (msg.text) {
        try {
          await figma.loadFontAsync(shape.text.fontName);
        } catch (e) {
          await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
          shape.text.fontName = { family: 'Inter', style: 'Medium' };
        }
        shape.text.characters = msg.text;
        if (typeof msg.fontSize === 'number') {
          shape.text.fontSize = msg.fontSize;
        }
      }

      figma.ui.postMessage({
        type: 'CREATE_SHAPE_WITH_TEXT_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: shape.id, type: shape.type, name: shape.name, x: shape.x, y: shape.y, width: shape.width, height: shape.height }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create shape with text error:', error);
      figma.ui.postMessage({
        type: 'CREATE_SHAPE_WITH_TEXT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_TABLE - Create a table with data
  else if (msg.type === 'CREATE_TABLE') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_TABLE is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating table:', msg.rows, 'x', msg.columns);

      var table = figma.createTable(msg.rows, msg.columns);

      if (typeof msg.x === 'number') table.x = msg.x;
      if (typeof msg.y === 'number') table.y = msg.y;

      // Populate cells if data provided
      if (msg.data && Array.isArray(msg.data)) {
        for (var row = 0; row < msg.data.length && row < msg.rows; row++) {
          for (var col = 0; col < msg.data[row].length && col < msg.columns; col++) {
            var cell = table.cellAt(row, col);
            if (cell && msg.data[row][col] != null) {
              await figma.loadFontAsync(cell.text.fontName);
              cell.text.characters = String(msg.data[row][col]);
            }
          }
        }
      }

      figma.ui.postMessage({
        type: 'CREATE_TABLE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: table.id, type: table.type, name: table.name, rows: msg.rows, columns: msg.columns }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create table error:', error);
      figma.ui.postMessage({
        type: 'CREATE_TABLE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_CODE_BLOCK - Create a code block
  else if (msg.type === 'CREATE_CODE_BLOCK') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('CREATE_CODE_BLOCK is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Creating code block');

      var codeBlock = figma.createCodeBlock();

      // Code blocks require Source Code Pro font, fall back to Inter if unavailable
      try {
        await figma.loadFontAsync({ family: 'Source Code Pro', style: 'Medium' });
      } catch (e) {
        await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
      }

      if (msg.code) {
        codeBlock.code = msg.code;
      }
      if (msg.language) {
        codeBlock.codeLanguage = msg.language;
      }

      if (typeof msg.x === 'number') codeBlock.x = msg.x;
      if (typeof msg.y === 'number') codeBlock.y = msg.y;

      figma.ui.postMessage({
        type: 'CREATE_CODE_BLOCK_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: codeBlock.id, type: codeBlock.type, name: codeBlock.name, x: codeBlock.x, y: codeBlock.y }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create code block error:', error);
      figma.ui.postMessage({
        type: 'CREATE_CODE_BLOCK_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_BOARD_CONTENTS - Read all FigJam nodes from the current page
  else if (msg.type === 'GET_BOARD_CONTENTS') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('GET_BOARD_CONTENTS is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Reading board contents');

      var maxNodes = msg.maxNodes || 500;
      var filterTypes = msg.nodeTypes || null;

      // FigJam node types we care about
      var figjamTypes = ['STICKY', 'SHAPE_WITH_TEXT', 'CONNECTOR', 'TABLE', 'CODE_BLOCK', 'SECTION', 'FRAME', 'TEXT'];

      var allNodes = figma.currentPage.children;
      var results = [];
      var truncated = false;

      for (var ni = 0; ni < allNodes.length && results.length < maxNodes; ni++) {
        var node = allNodes[ni];

        // Skip if filtering and this type isn't in the filter list
        if (filterTypes && filterTypes.indexOf(node.type) === -1) continue;
        // Skip if not a FigJam-relevant type
        if (!filterTypes && figjamTypes.indexOf(node.type) === -1) continue;

        var entry = {
          id: node.id,
          type: node.type,
          name: node.name,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height
        };

        // Extract text content based on node type
        if (node.type === 'STICKY') {
          entry.text = node.text ? node.text.characters : '';
          if (node.fills && node.fills.length > 0 && node.fills[0].color) {
            entry.color = node.fills[0].color;
          }
        } else if (node.type === 'SHAPE_WITH_TEXT') {
          entry.text = node.text ? node.text.characters : '';
          entry.shapeType = node.shapeType || 'ROUNDED_RECTANGLE';
        } else if (node.type === 'CONNECTOR') {
          entry.connectorStart = node.connectorStart || null;
          entry.connectorEnd = node.connectorEnd || null;
          entry.text = node.text ? node.text.characters : '';
        } else if (node.type === 'CODE_BLOCK') {
          entry.code = node.code || '';
          entry.codeLanguage = node.codeLanguage || '';
        } else if (node.type === 'TABLE') {
          entry.numRows = node.numRows;
          entry.numColumns = node.numColumns;
          // Read first 10 rows of cell data to avoid huge payloads
          var cellData = [];
          var maxCellRows = Math.min(node.numRows, 10);
          for (var row = 0; row < maxCellRows; row++) {
            var rowData = [];
            for (var col = 0; col < node.numColumns; col++) {
              try {
                var cell = node.cellAt(row, col);
                rowData.push(cell && cell.text ? cell.text.characters : '');
              } catch (e) {
                rowData.push('');
              }
            }
            cellData.push(rowData);
          }
          entry.cellData = cellData;
          if (node.numRows > 10) entry.cellDataTruncated = true;
        } else if (node.type === 'SECTION') {
          entry.childCount = node.children ? node.children.length : 0;
        } else if (node.type === 'TEXT') {
          entry.text = node.characters || '';
        }

        results.push(entry);
      }

      if (results.length >= maxNodes) truncated = true;

      figma.ui.postMessage({
        type: 'GET_BOARD_CONTENTS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          nodes: results,
          totalFound: results.length,
          truncated: truncated,
          page: figma.currentPage.name
        }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get board contents error:', error);
      figma.ui.postMessage({
        type: 'GET_BOARD_CONTENTS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_CONNECTIONS - Read the connection graph from the board
  else if (msg.type === 'GET_CONNECTIONS') {
    try {
      if (__editorType !== 'figjam') {
        throw new Error('GET_CONNECTIONS is only available in FigJam files');
      }
      console.log('🌉 [Desktop Bridge] Reading connection graph');

      var connectors = figma.currentPage.findAll(function(n) { return n.type === 'CONNECTOR'; });
      var edges = [];
      var nodeMap = {};

      for (var ci = 0; ci < connectors.length; ci++) {
        var conn = connectors[ci];
        var startId = conn.connectorStart ? conn.connectorStart.endpointNodeId : null;
        var endId = conn.connectorEnd ? conn.connectorEnd.endpointNodeId : null;
        var label = conn.text ? conn.text.characters : '';

        edges.push({
          connectorId: conn.id,
          startNodeId: startId,
          endNodeId: endId,
          label: label
        });

        // Build a lookup of connected nodes with their names/types
        if (startId && !nodeMap[startId]) {
          var startNode = await figma.getNodeByIdAsync(startId);
          if (startNode) {
            nodeMap[startId] = {
              id: startId,
              type: startNode.type,
              name: startNode.name,
              text: startNode.text ? startNode.text.characters : (startNode.characters || '')
            };
          }
        }
        if (endId && !nodeMap[endId]) {
          var endNode = await figma.getNodeByIdAsync(endId);
          if (endNode) {
            nodeMap[endId] = {
              id: endId,
              type: endNode.type,
              name: endNode.name,
              text: endNode.text ? endNode.text.characters : (endNode.characters || '')
            };
          }
        }
      }

      figma.ui.postMessage({
        type: 'GET_CONNECTIONS_RESULT',
        requestId: msg.requestId,
        success: true,
        data: {
          edges: edges,
          connectedNodes: nodeMap,
          totalConnectors: connectors.length,
          totalConnectedNodes: Object.keys(nodeMap).length
        }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get connections error:', error);
      figma.ui.postMessage({
        type: 'GET_CONNECTIONS_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }
  // ==========================================================================
  // SLIDES TOOLS — Figma Slides command handlers
  // ==========================================================================

  // LIST_SLIDES - List all slides in the presentation
  else if (msg.type === 'LIST_SLIDES') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('LIST_SLIDES is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Listing slides');

      var grid = figma.getSlideGrid();
      var slides = [];
      for (var rowIdx = 0; rowIdx < grid.length; rowIdx++) {
        var row = grid[rowIdx];
        // SlideGrid rows are array-like (iterable with numeric indices), not objects with .children
        for (var colIdx = 0; colIdx < row.length; colIdx++) {
          var slide = row[colIdx];
          slides.push({
            id: slide.id,
            name: slide.name,
            row: rowIdx,
            col: colIdx,
            isSkippedSlide: slide.isSkippedSlide,
            childCount: slide.children ? slide.children.length : 0
          });
        }
      }

      figma.ui.postMessage({
        type: 'LIST_SLIDES_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { slides: slides, totalSlides: slides.length, totalRows: grid.length }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] List slides error:', error);
      figma.ui.postMessage({
        type: 'LIST_SLIDES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_SLIDE_CONTENT - Get node tree of a slide
  else if (msg.type === 'GET_SLIDE_CONTENT') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('GET_SLIDE_CONTENT is only available in Slides files');
      }
      var slideNode = await figma.getNodeByIdAsync(msg.slideId);
      if (!slideNode || slideNode.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Getting slide content:', slideNode.name);

      function serializeNode(n) {
        var result = { id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height };
        if (n.type === 'TEXT') {
          result.characters = n.characters;
          result.fontSize = n.fontSize;
        }
        if (n.children && n.children.length > 0) {
          result.children = [];
          for (var i = 0; i < n.children.length; i++) {
            result.children.push(serializeNode(n.children[i]));
          }
        }
        return result;
      }

      figma.ui.postMessage({
        type: 'GET_SLIDE_CONTENT_RESULT',
        requestId: msg.requestId,
        success: true,
        data: serializeNode(slideNode)
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get slide content error:', error);
      figma.ui.postMessage({
        type: 'GET_SLIDE_CONTENT_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // CREATE_SLIDE - Create a new slide
  else if (msg.type === 'CREATE_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('CREATE_SLIDE is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Creating slide');

      var newSlide;
      if (typeof msg.row === 'number' && typeof msg.col === 'number') {
        newSlide = figma.createSlide({ row: msg.row, col: msg.col });
      } else {
        newSlide = figma.createSlide();
      }

      figma.ui.postMessage({
        type: 'CREATE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: newSlide.id, name: newSlide.name }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Create slide error:', error);
      figma.ui.postMessage({
        type: 'CREATE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // DELETE_SLIDE - Delete a slide
  else if (msg.type === 'DELETE_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('DELETE_SLIDE is only available in Slides files');
      }
      var delSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!delSlide || delSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Deleting slide:', delSlide.name);

      var delName = delSlide.name;
      delSlide.remove();

      figma.ui.postMessage({
        type: 'DELETE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { deleted: msg.slideId, name: delName }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Delete slide error:', error);
      figma.ui.postMessage({
        type: 'DELETE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // DUPLICATE_SLIDE - Clone a slide
  else if (msg.type === 'DUPLICATE_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('DUPLICATE_SLIDE is only available in Slides files');
      }
      var srcSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!srcSlide || srcSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Duplicating slide:', srcSlide.name);

      var clone = srcSlide.clone();

      figma.ui.postMessage({
        type: 'DUPLICATE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { originalId: msg.slideId, newId: clone.id, name: clone.name }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Duplicate slide error:', error);
      figma.ui.postMessage({
        type: 'DUPLICATE_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_SLIDE_GRID - Get 2D grid layout
  else if (msg.type === 'GET_SLIDE_GRID') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('GET_SLIDE_GRID is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Getting slide grid');

      var slideGrid = figma.getSlideGrid();
      var gridData = [];
      for (var ri = 0; ri < slideGrid.length; ri++) {
        var gridRow = slideGrid[ri];
        var rowSlides = [];
        // SlideGrid rows are array-like (iterable with numeric indices)
        for (var ci = 0; ci < gridRow.length; ci++) {
          var gs = gridRow[ci];
          rowSlides.push({ id: gs.id, name: gs.name, col: ci, isSkippedSlide: gs.isSkippedSlide });
        }
        gridData.push({ rowIndex: ri, slides: rowSlides });
      }

      figma.ui.postMessage({
        type: 'GET_SLIDE_GRID_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { grid: gridData, totalRows: gridData.length }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get slide grid error:', error);
      figma.ui.postMessage({
        type: 'GET_SLIDE_GRID_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // REORDER_SLIDES - Reorder slides via 2D grid of slide IDs
  else if (msg.type === 'REORDER_SLIDES') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('REORDER_SLIDES is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Reordering slides');

      var newGrid = msg.grid; // 2D array of slide IDs

      // Build a lookup: slideId → SlideNode from the current grid
      var currentGrid = figma.getSlideGrid();
      var slideMap = {};
      for (var gri = 0; gri < currentGrid.length; gri++) {
        var grow = currentGrid[gri];
        for (var gci = 0; gci < grow.length; gci++) {
          slideMap[grow[gci].id] = grow[gci];
        }
      }

      // Build new grid as arrays of SlideNode references
      var reorderedRows = [];
      for (var rri = 0; rri < newGrid.length; rri++) {
        var rowIds = newGrid[rri];
        var rowSlides = [];
        for (var cci = 0; cci < rowIds.length; cci++) {
          var slideRef = slideMap[rowIds[cci]];
          if (!slideRef) throw new Error('Slide not found in current grid: ' + rowIds[cci]);
          rowSlides.push(slideRef);
        }
        reorderedRows.push(rowSlides);
      }

      figma.setSlideGrid(reorderedRows);

      figma.ui.postMessage({
        type: 'REORDER_SLIDES_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { success: true, rows: reorderedRows.length }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Reorder slides error:', error);
      figma.ui.postMessage({
        type: 'REORDER_SLIDES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // SET_SLIDE_TRANSITION - Set transition on a slide
  else if (msg.type === 'SET_SLIDE_TRANSITION') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('SET_SLIDE_TRANSITION is only available in Slides files');
      }
      var transSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!transSlide || transSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Setting slide transition:', transSlide.name);

      var transConfig = {
        style: msg.style,
        duration: msg.duration,
        curve: msg.curve,
        timing: { type: 'ON_CLICK' }
      };
      if (msg.timing) {
        transConfig.timing = msg.timing;
      }
      transSlide.setSlideTransition(transConfig);

      figma.ui.postMessage({
        type: 'SET_SLIDE_TRANSITION_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: transSlide.id, transition: transSlide.getSlideTransition() }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Set slide transition error:', error);
      figma.ui.postMessage({
        type: 'SET_SLIDE_TRANSITION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_SLIDE_TRANSITION - Read transition from a slide
  else if (msg.type === 'GET_SLIDE_TRANSITION') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('GET_SLIDE_TRANSITION is only available in Slides files');
      }
      var readTransSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!readTransSlide || readTransSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Getting slide transition:', readTransSlide.name);

      figma.ui.postMessage({
        type: 'GET_SLIDE_TRANSITION_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: readTransSlide.id, transition: readTransSlide.getSlideTransition() }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get slide transition error:', error);
      figma.ui.postMessage({
        type: 'GET_SLIDE_TRANSITION_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // SET_SLIDES_VIEW_MODE - Toggle between grid and single-slide view
  else if (msg.type === 'SET_SLIDES_VIEW_MODE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('SET_SLIDES_VIEW_MODE is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Setting slides view mode:', msg.mode);

      figma.viewport.slidesView = msg.mode;

      figma.ui.postMessage({
        type: 'SET_SLIDES_VIEW_MODE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { mode: figma.viewport.slidesView }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Set slides view mode error:', error);
      figma.ui.postMessage({
        type: 'SET_SLIDES_VIEW_MODE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_FOCUSED_SLIDE - Get currently focused slide
  else if (msg.type === 'GET_FOCUSED_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('GET_FOCUSED_SLIDE is only available in Slides files');
      }
      console.log('🌉 [Desktop Bridge] Getting focused slide');

      var focused = figma.currentPage.focusedSlide;
      var focusData = focused ? { id: focused.id, name: focused.name } : { focused: null };

      figma.ui.postMessage({
        type: 'GET_FOCUSED_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: focusData
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get focused slide error:', error);
      figma.ui.postMessage({
        type: 'GET_FOCUSED_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // FOCUS_SLIDE - Navigate to a specific slide
  else if (msg.type === 'FOCUS_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('FOCUS_SLIDE is only available in Slides files');
      }
      var focusTarget = await figma.getNodeByIdAsync(msg.slideId);
      if (!focusTarget || focusTarget.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Focusing slide:', focusTarget.name);

      figma.viewport.slidesView = 'single-slide';
      figma.currentPage.focusedSlide = focusTarget;

      figma.ui.postMessage({
        type: 'FOCUS_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { focused: focusTarget.id, name: focusTarget.name }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Focus slide error:', error);
      figma.ui.postMessage({
        type: 'FOCUS_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // SKIP_SLIDE - Toggle skip on a slide
  else if (msg.type === 'SKIP_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('SKIP_SLIDE is only available in Slides files');
      }
      var skipSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!skipSlide || skipSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Toggling slide skip:', skipSlide.name, '→', msg.skip);

      skipSlide.isSkippedSlide = !!msg.skip;

      figma.ui.postMessage({
        type: 'SKIP_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: skipSlide.id, isSkippedSlide: skipSlide.isSkippedSlide }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Skip slide error:', error);
      figma.ui.postMessage({
        type: 'SKIP_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // GET_TEXT_STYLES - Get all local text styles
  else if (msg.type === 'GET_TEXT_STYLES') {
    try {
      var textStyles = await figma.getLocalTextStylesAsync();
      var styles = [];
      for (var si = 0; si < textStyles.length; si++) {
        var style = textStyles[si];
        styles.push({
          id: style.id,
          name: style.name,
          description: style.description || '',
          fontSize: style.fontSize,
          fontFamily: style.fontName ? style.fontName.family : 'unknown',
          fontStyle: style.fontName ? style.fontName.style : 'unknown',
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight,
          textCase: style.textCase,
          textDecoration: style.textDecoration
        });
      }
      console.log('🌉 [Desktop Bridge] Got ' + styles.length + ' text styles');

      figma.ui.postMessage({
        type: 'GET_TEXT_STYLES_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { styles: styles, count: styles.length }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Get text styles error:', error);
      figma.ui.postMessage({
        type: 'GET_TEXT_STYLES_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // SET_SLIDE_BACKGROUND - Set slide background color
  else if (msg.type === 'SET_SLIDE_BACKGROUND') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('SET_SLIDE_BACKGROUND is only available in Slides files');
      }
      var bgSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!bgSlide || bgSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Setting slide background:', bgSlide.name);

      // Parse hex color
      var bgHex = (msg.color || '#CCCCCC').replace('#', '');
      var bgR = parseInt(bgHex.substring(0, 2), 16) / 255;
      var bgG = parseInt(bgHex.substring(2, 4), 16) / 255;
      var bgB = parseInt(bgHex.substring(4, 6), 16) / 255;
      var bgColor = { r: bgR, g: bgG, b: bgB };

      // Check if a background rectangle already exists
      var existingBg = null;
      for (var ci = 0; ci < bgSlide.children.length; ci++) {
        var child = bgSlide.children[ci];
        if (child.type === 'RECTANGLE' && child.name === 'Background' && child.width === 1920 && child.height === 1080) {
          existingBg = child;
          break;
        }
      }

      if (existingBg) {
        // Update existing background
        existingBg.fills = [{ type: 'SOLID', color: bgColor }];
      } else {
        // Create new background rectangle
        var bgRect = figma.createRectangle();
        bgRect.name = 'Background';
        bgRect.resize(1920, 1080);
        bgRect.x = 0;
        bgRect.y = 0;
        bgRect.fills = [{ type: 'SOLID', color: bgColor }];
        bgSlide.appendChild(bgRect);
        bgSlide.insertChild(0, bgRect);
      }

      figma.ui.postMessage({
        type: 'SET_SLIDE_BACKGROUND_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { slideId: bgSlide.id, color: msg.color, updated: !!existingBg }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Set slide background error:', error);
      figma.ui.postMessage({
        type: 'SET_SLIDE_BACKGROUND_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ADD_TEXT_TO_SLIDE - Add a text node to a slide
  else if (msg.type === 'ADD_TEXT_TO_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('ADD_TEXT_TO_SLIDE is only available in Slides files');
      }
      var textSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!textSlide || textSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Adding text to slide:', textSlide.name);

      var textNode = figma.createText();
      var fontFamily = msg.fontFamily || 'Inter';
      var fontStyle = msg.fontStyle || 'Regular';
      var slideFont = await loadFontWithFallback(fontFamily, fontStyle);
      textNode.fontName = slideFont;
      textNode.characters = msg.text || '';
      textNode.fontSize = msg.fontSize || 24;
      textNode.x = typeof msg.x === 'number' ? msg.x : 100;
      textNode.y = typeof msg.y === 'number' ? msg.y : 100;
      if (msg.color) {
        var hex = msg.color.replace('#', '');
        var r = parseInt(hex.substring(0, 2), 16) / 255;
        var g = parseInt(hex.substring(2, 4), 16) / 255;
        var b = parseInt(hex.substring(4, 6), 16) / 255;
        textNode.fills = [{ type: 'SOLID', color: { r: r, g: g, b: b } }];
      }
      if (msg.textAlign) {
        textNode.textAlignHorizontal = msg.textAlign;
      }
      if (msg.width) {
        textNode.resize(msg.width, textNode.height);
        textNode.textAutoResize = 'HEIGHT';
      }
      if (typeof msg.lineHeight === 'number') {
        textNode.lineHeight = { value: msg.lineHeight, unit: 'PIXELS' };
      }
      if (typeof msg.letterSpacing === 'number') {
        textNode.letterSpacing = { value: msg.letterSpacing, unit: 'PIXELS' };
      }
      if (msg.textCase) {
        textNode.textCase = msg.textCase;
      }
      textSlide.appendChild(textNode);

      figma.ui.postMessage({
        type: 'ADD_TEXT_TO_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: textNode.id, text: textNode.characters }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Add text to slide error:', error);
      figma.ui.postMessage({
        type: 'ADD_TEXT_TO_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }

  // ADD_SHAPE_TO_SLIDE - Add a shape to a slide
  else if (msg.type === 'ADD_SHAPE_TO_SLIDE') {
    try {
      if (__editorType !== 'slides') {
        throw new Error('ADD_SHAPE_TO_SLIDE is only available in Slides files');
      }
      var shapeSlide = await figma.getNodeByIdAsync(msg.slideId);
      if (!shapeSlide || shapeSlide.type !== 'SLIDE') {
        throw new Error('Node ' + msg.slideId + ' is not a SLIDE');
      }
      console.log('🌉 [Desktop Bridge] Adding shape to slide:', shapeSlide.name);

      var shape;
      if (msg.shapeType === 'ELLIPSE') {
        shape = figma.createEllipse();
      } else {
        shape = figma.createRectangle();
      }
      shape.x = typeof msg.x === 'number' ? msg.x : 100;
      shape.y = typeof msg.y === 'number' ? msg.y : 100;
      shape.resize(typeof msg.width === 'number' ? msg.width : 200, typeof msg.height === 'number' ? msg.height : 200);

      if (msg.color && typeof msg.color === 'string') {
        var hex = msg.color.replace('#', '');
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
          shape.fills = [{
            type: 'SOLID',
            color: {
              r: parseInt(hex.substring(0, 2), 16) / 255,
              g: parseInt(hex.substring(2, 4), 16) / 255,
              b: parseInt(hex.substring(4, 6), 16) / 255
            }
          }];
        }
      }
      shapeSlide.appendChild(shape);

      figma.ui.postMessage({
        type: 'ADD_SHAPE_TO_SLIDE_RESULT',
        requestId: msg.requestId,
        success: true,
        data: { id: shape.id, type: shape.type }
      });

    } catch (error) {
      console.error('🌉 [Desktop Bridge] Add shape to slide error:', error);
      figma.ui.postMessage({
        type: 'ADD_SHAPE_TO_SLIDE_RESULT',
        requestId: msg.requestId,
        success: false,
        error: error.message || String(error)
      });
    }
  }
};

// ============================================================================
// DOCUMENT CHANGE LISTENER - Forward change events for cache invalidation
// Fires when variables, styles, or nodes change (by any means — user edits, API, etc.)
// Requires figma.loadAllPagesAsync() in dynamic-page mode before registering.
// ============================================================================
figma.loadAllPagesAsync().then(function() {
  figma.on('documentchange', function(event) {
    var hasStyleChanges = false;
    var hasNodeChanges = false;
    var changedNodeIds = [];

    // v1.25.0: also collect metadata-only changes (descriptions, annotations).
    // These are properties that the REST API DOESN'T expose in version snapshots,
    // so figma_diff_versions can't see them through REST alone. Forwarding them
    // via the Plugin API + WebSocket is the only way to make them diff-visible.
    var metadataChanges = [];

    for (var i = 0; i < event.documentChanges.length; i++) {
      var change = event.documentChanges[i];
      if (change.id && ghostIds[change.id]) continue; // ignore our own ghost cursor nodes
      if (change.type === 'STYLE_CREATE' || change.type === 'STYLE_DELETE' || change.type === 'STYLE_PROPERTY_CHANGE') {
        hasStyleChanges = true;
      } else if (change.type === 'CREATE' || change.type === 'DELETE' || change.type === 'PROPERTY_CHANGE') {
        hasNodeChanges = true;
        if (change.id && changedNodeIds.length < 50) {
          changedNodeIds.push(change.id);
        }
      }

      // Metadata change detection. PROPERTY_CHANGE includes a `properties` array
      // listing which fields changed; we only snapshot the new value for the
      // two fields Figma's REST never returns: `description` and `annotations`.
      if (change.type === 'PROPERTY_CHANGE' && change.node && Array.isArray(change.properties)) {
        for (var p = 0; p < change.properties.length; p++) {
          var prop = change.properties[p];
          if (prop === 'description' || prop === 'descriptionMarkdown' || prop === 'annotations') {
            try {
              var newValue = change.node[prop];
              // Serialize annotations to plain JSON-safe form
              if (prop === 'annotations' && Array.isArray(newValue)) {
                newValue = newValue.map(function(a) {
                  return {
                    label: a.label || null,
                    labelMarkdown: a.labelMarkdown || null,
                    categoryId: a.categoryId || null,
                    properties: a.properties || []
                  };
                });
              }
              metadataChanges.push({
                node_id: change.node.id,
                node_name: change.node.name || null,
                node_type: change.node.type || null,
                field: prop === 'descriptionMarkdown' ? 'description' : prop,
                new_value: newValue,
                timestamp: Date.now()
              });
            } catch (e) {
              // Some property reads can throw on detached / deleted nodes
            }
          }
        }
      }
    }

    if (metadataChanges.length > 0) {
      figma.ui.postMessage({
        type: 'METADATA_CHANGE',
        data: { changes: metadataChanges }
      });
    }

    if (hasStyleChanges || hasNodeChanges) {
      figma.ui.postMessage({
        type: 'DOCUMENT_CHANGE',
        data: {
          hasStyleChanges: hasStyleChanges,
          hasNodeChanges: hasNodeChanges,
          changedNodeIds: changedNodeIds,
          changeCount: event.documentChanges.length,
          timestamp: Date.now()
        }
      });
    }
  });
  // Selection change listener — tracks what the user has selected in Figma
  figma.on('selectionchange', function() {
    var selection = figma.currentPage.selection;
    var selectedNodes = [];
    for (var i = 0; i < Math.min(selection.length, 50); i++) {
      try {
        var node = selection[i];
        selectedNodes.push({
          id: node.id,
          name: node.name,
          type: node.type,
          width: node.width,
          height: node.height
        });
      } catch (e) {
        // Slot sublayers and table cells may not be fully resolvable —
        // accessing .name throws "does not exist" for these node types.
        // Skip silently rather than crashing the plugin.
      }
    }
    figma.ui.postMessage({
      type: 'SELECTION_CHANGE',
      data: {
        nodes: selectedNodes,
        count: selection.length,
        page: figma.currentPage.name,
        timestamp: Date.now()
      }
    });
  });

  // Page change listener — tracks which page the user is viewing
  figma.on('currentpagechange', function() {
    figma.ui.postMessage({
      type: 'PAGE_CHANGE',
      data: {
        pageId: figma.currentPage.id,
        pageName: figma.currentPage.name,
        timestamp: Date.now()
      }
    });
  });

  console.log('🌉 [Desktop Bridge] Document change, selection, and page listeners registered');
}).catch(function(err) {
  console.warn('🌉 [Desktop Bridge] Could not register event listeners:', err);
});

console.log('🌉 [Desktop Bridge] Ready to handle component requests');
console.log('🌉 [Desktop Bridge] Plugin will stay open until manually closed');

// Plugin stays open - no auto-close
// UI iframe remains accessible so the in-iframe WebSocket bridge client can keep relaying state to the MCP server

// =====================================================================
// Custom fiGapture: build screenshots + design system from saved captures
// (called from ui.html: FIGAPTURE_BUILD)
// =====================================================================
var FS_WEIGHT_STYLE = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };
var FS_INK = { r: 0.09, g: 0.09, b: 0.11, a: 1 };
var FS_MUTED = { r: 0.44, g: 0.44, b: 0.48, a: 1 };
var FS_WHITE = { r: 1, g: 1, b: 1, a: 1 };

function fsParseColor(str) {
  if (!str) return null;
  str = String(str).trim();
  var m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    var h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
    if (h.length === 6 || h.length === 8) {
      return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    return null;
  }
  m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    var a = m[4] === undefined ? 1 : (String(m[4]).indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: Math.min(1, m[1] / 255), g: Math.min(1, m[2] / 255), b: Math.min(1, m[3] / 255), a: isNaN(a) ? 1 : a };
  }
  return null;
}
function fsSolid(c) { return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a === undefined ? 1 : c.a }; }
function fsPx(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

// Each font is asked for once: on a big page every font request makes Figma redraw, which costs seconds.
var fsFontCache = {};
function fsLoadFont(family, weight) {
  var w = Math.round((parseInt(weight, 10) || 400) / 100) * 100, k = family + '|' + w;
  if (!fsFontCache[k]) fsFontCache[k] = (async function () {
    var style = FS_WEIGHT_STYLE[w] || 'Regular';
    var tries = [{ family: family, style: style }, { family: 'Inter', style: style }, { family: 'Inter', style: 'Regular' }];
    for (var i = 0; i < tries.length; i++) {
      try { await figma.loadFontAsync(tries[i]); return tries[i]; } catch (e) { /* try next */ }
    }
    return { family: 'Inter', style: 'Regular' };
  })();
  return fsFontCache[k];
}
async function fsText(str, size, weight, color, family) {
  var f = await fsLoadFont(family || 'Inter', weight || 400);
  var t = figma.createText();
  t.fontName = f;
  t.fontSize = size || 12;
  t.characters = String(str === undefined || str === null ? '' : str);
  t.fills = [fsSolid(color || FS_INK)];
  return t;
}
function fsFrame(name, dir, gap, pad) {
  var f = figma.createFrame();
  f.name = name; f.fills = [];
  f.layoutMode = dir;
  f.itemSpacing = gap || 0;
  f.paddingLeft = f.paddingRight = f.paddingTop = f.paddingBottom = pad || 0;
  f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO';
  return f;
}
function fsWrapRow(name, width, gap) {
  var f = figma.createFrame();
  f.name = name; f.fills = [];
  f.layoutMode = 'HORIZONTAL'; f.layoutWrap = 'WRAP';
  f.itemSpacing = gap; f.counterAxisSpacing = gap;
  f.resize(width, 10);
  f.primaryAxisSizingMode = 'FIXED'; f.counterAxisSizingMode = 'AUTO';
  return f;
}
function fsParseShadow(v) {
  var first = String(v).split(/,(?![^(]*\))/)[0];
  if (/inset/i.test(first)) return null;
  var col = first.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i);
  var c = col ? fsParseColor(col[0]) : { r: 0, g: 0, b: 0, a: 0.25 };
  if (!c) return null;
  var nums = first.replace(col ? col[0] : '', '').match(/-?[\d.]+px|-?\b0\b/g) || [];
  var n = nums.map(function (x) { return parseFloat(x); });
  if (n.length < 2) return null;
  return { type: 'DROP_SHADOW', color: { r: c.r, g: c.g, b: c.b, a: c.a }, offset: { x: n[0], y: n[1] }, radius: Math.max(0, n[2] || 0), spread: n[3] || 0, visible: true, blendMode: 'NORMAL' };
}
async function fsHeading(title, sub) {
  var box = fsFrame('heading', 'VERTICAL', 4, 0);
  box.appendChild(await fsText(title, 22, 700, FS_INK));
  if (sub) box.appendChild(await fsText(sub, 13, 400, FS_MUTED));
  return box;
}

// One Section per page: its screenshots stacked top to bottom.
async function fsBuildPage(host, p, x, y) {
  var section = figma.createSection(); fsCreated.push(section);
  section.name = host + p.path;
  section.x = x; section.y = y;
  var dpr = p.dpr || 1;
  var w = Math.round(p.pageWidth || 1440);
  var stack = fsFrame('Screenshots', 'VERTICAL', 24, 0);
  var n = p.slices.length;
  for (var i = 0; i < n; i++) {
    var s = p.slices[i];
    var fr = figma.createFrame();
    fr.name = 'screenshot ' + (i + 1) + '/' + n;
    fr.resize(w, Math.max(1, Math.round(s.height / dpr)));
    fr.fills = []; fr.clipsContent = true;
    // Full resolution: each slice is made of tiles of at most 4096px (Figma's image limit).
    for (var ti2 = 0; ti2 < s.tiles.length; ti2++) {
      var tl = s.tiles[ti2];
      var img = figma.createImage(tl.bytes);
      var rc = figma.createRectangle();
      rc.name = 'tile';
      rc.resize(Math.max(0.01, tl.width / dpr), Math.max(0.01, tl.height / dpr));
      rc.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
      fr.appendChild(rc);
      rc.x = tl.x / dpr; rc.y = tl.y / dpr;
    }
    stack.appendChild(fr);
  }
  section.appendChild(stack);
  stack.x = 60; stack.y = 100;
  section.resizeWithoutConstraints(Math.max(200, stack.width + 120), Math.max(200, stack.height + 160));
  return section;
}

// One Section per website: real variables + styles + a documentation frame with components.
async function fsBuildDesign(host, d, pages, x, y, stats) {
  var section = figma.createSection(); fsCreated.push(section);
  section.name = host + ' — Design system';
  section.x = x; section.y = y;

  // A documentation frame only. Nothing is added to the file itself: no variables, no text / colour /
  // effect styles and no components.
  var typo = (d.typography || []).slice(0, 10);
  var shadowStyles = [];
  (d.shadows || []).slice(0, 8).forEach(function (s) { var eff = null; try { eff = fsParseShadow(s.value); } catch (e) { eff = null; } if (eff) shadowStyles.push({ eff: eff, value: s.value, count: s.count }); });

  // All fonts up front, at the same time.
  var fontWant = {}; [400, 500, 600, 700].forEach(function (w) { fontWant['Inter|' + w] = ['Inter', w]; });
  (d.typography || []).slice(0, 16).forEach(function (t) { fontWant[t.family + '|' + t.weight] = [t.family, t.weight]; });
  (d.components || []).slice(0, 80).forEach(function (q) { var z = (q.sample && q.sample.styles) || {}; var fam = String(z.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim(); fontWant[fam + '|' + z.fontWeight] = [fam, z.fontWeight]; });
  await Promise.all(Object.keys(fontWant).map(function (k) { return fsLoadFont(fontWant[k][0], fontWant[k][1]); }));

  // ---- Documentation frame
  var W = 1200, INNER = W - 96;
  var doc = fsFrame('Design system', 'VERTICAL', 40, 48);
  doc.fills = [fsSolid(FS_WHITE)];
  doc.resize(W, 100); doc.primaryAxisSizingMode = 'AUTO'; doc.counterAxisSizingMode = 'FIXED';
  doc.appendChild(await fsText('Design system — ' + host, 34, 700, FS_INK));
  doc.appendChild(await fsText('Merged from ' + pages.length + ' captured page(s). Extracted from computed styles; hover/focus states are not captured.', 13, 400, FS_MUTED));
  var pageList = pages.map(function (p) { return p.path + (p.title ? ' — ' + p.title : ''); }).join('\n').slice(0, 1500);
  if (pageList) { var pl = await fsText(pageList, 12, 400, { r: 0.25, g: 0.25, b: 0.28, a: 1 }); doc.appendChild(pl); }

  // Colors
  if ((d.colors || []).length) {
    var cs = fsFrame('Colors', 'VERTICAL', 16, 0);
    cs.appendChild(await fsHeading('Colors', d.colors.length + ' unique colors, most used first'));
    var grid = fsWrapRow('swatches', INNER, 16);
    for (var ci = 0; ci < Math.min(48, d.colors.length); ci++) {
      var c = d.colors[ci], rgba = fsParseColor(c.value); if (!rgba) continue;
      var sw = fsFrame('swatch ' + c.value, 'VERTICAL', 6, 0);
      var rect = figma.createRectangle(); rect.name = 'color'; rect.resize(130, 64); rect.cornerRadius = 8;
      rect.fills = [fsSolid(rgba)]; rect.strokes = [fsSolid({ r: 0.89, g: 0.89, b: 0.91, a: 1 })]; rect.strokeWeight = 1;
      sw.appendChild(rect);
      sw.appendChild(await fsText(String(c.value).toUpperCase(), 13, 600, FS_INK));
      sw.appendChild(await fsText((c.roles || []).join(', ') + ' · ×' + c.count, 11, 400, FS_MUTED));
      grid.appendChild(sw);
    }
    cs.appendChild(grid); doc.appendChild(cs);
  }
  // Typography
  if (typo.length) {
    var ty = fsFrame('Typography', 'VERTICAL', 14, 0);
    ty.appendChild(await fsHeading('Typography', (d.typography || []).length + ' text styles'));
    for (var yi = 0; yi < Math.min(16, (d.typography || []).length); yi++) {
      var tt = d.typography[yi];
      var row = fsFrame('type ' + (yi + 1), 'VERTICAL', 4, 0);
      var sample = await fsText('The quick brown fox jumps over the lazy dog', Math.min(64, fsPx(tt.size) || 14), tt.weight, FS_INK, tt.family);
      row.appendChild(sample);
      row.appendChild(await fsText(tt.family + ' · ' + tt.size + ' / ' + tt.lineHeight + ' · weight ' + tt.weight + ' · ×' + tt.count, 11, 400, FS_MUTED));
      ty.appendChild(row);
    }
    doc.appendChild(ty);
  }
  // Spacing
  if ((d.spacing || []).length) {
    var sp = fsFrame('Spacing', 'VERTICAL', 8, 0);
    sp.appendChild(await fsHeading('Spacing', 'Most used padding / margin / gap values'));
    var spList = d.spacing.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 16).sort(function (a, b) { return fsPx(a.value) - fsPx(b.value); });
    for (var si = 0; si < spList.length; si++) {
      var r2 = fsFrame('space ' + spList[si].value, 'HORIZONTAL', 12, 0); r2.counterAxisAlignItems = 'CENTER';
      var lbl = await fsText(spList[si].value, 12, 600, FS_INK); lbl.resize(70, lbl.height); lbl.textAutoResize = 'HEIGHT';
      var bar = figma.createRectangle(); bar.resize(Math.max(2, Math.min(400, fsPx(spList[si].value))), 12); bar.cornerRadius = 2; bar.fills = [fsSolid({ r: 0.39, g: 0.4, b: 0.95, a: 1 })];
      r2.appendChild(lbl); r2.appendChild(bar); r2.appendChild(await fsText('×' + spList[si].count, 11, 400, FS_MUTED));
      sp.appendChild(r2);
    }
    doc.appendChild(sp);
  }
  // Radius + shadows
  if ((d.radii || []).length) {
    var rd = fsFrame('Border radius', 'VERTICAL', 16, 0);
    rd.appendChild(await fsHeading('Border radius'));
    var rg = fsWrapRow('radii', INNER, 20);
    for (var ri = 0; ri < Math.min(12, d.radii.length); ri++) {
      var rc = fsFrame('radius ' + d.radii[ri].value, 'VERTICAL', 8, 0);
      var rr = figma.createRectangle(); rr.resize(72, 72); rr.cornerRadius = /%/.test(d.radii[ri].value) ? 36 : Math.min(36, fsPx(d.radii[ri].value));
      rr.fills = [fsSolid({ r: 0.96, g: 0.96, b: 0.97, a: 1 })]; rr.strokes = [fsSolid({ r: 0.83, g: 0.83, b: 0.85, a: 1 })]; rr.strokeWeight = 1;
      rc.appendChild(rr); rc.appendChild(await fsText(String(d.radii[ri].value) + ' · ×' + d.radii[ri].count, 11, 400, FS_MUTED));
      rg.appendChild(rc);
    }
    rd.appendChild(rg); doc.appendChild(rd);
  }
  if (shadowStyles.length) {
    var sh = fsFrame('Shadows', 'VERTICAL', 16, 0);
    sh.appendChild(await fsHeading('Shadows'));
    var shg = fsWrapRow('shadows', INNER, 28);
    for (var hi = 0; hi < shadowStyles.length; hi++) {
      var hc = fsFrame('shadow ' + (hi + 1), 'VERTICAL', 10, 0);
      var hr = figma.createRectangle(); hr.resize(120, 80); hr.cornerRadius = 8; hr.fills = [fsSolid(FS_WHITE)]; hr.effects = [shadowStyles[hi].eff];
      hc.appendChild(hr); hc.appendChild(await fsText(String(shadowStyles[hi].value).slice(0, 48) + ' · ×' + shadowStyles[hi].count, 11, 400, FS_MUTED));
      shg.appendChild(hc);
    }
    sh.appendChild(shg); doc.appendChild(sh);
  }
  // Component samples (plain frames built from the captured computed styles)
  var comps = d.components || [];
  if (comps.length) {
    var cp = fsFrame('Components', 'VERTICAL', 24, 0);
    cp.appendChild(await fsHeading('Components', 'Distinct style variants found on the pages'));
    var byType = {}; var order = [];
    comps.forEach(function (c) { if (!byType[c.type]) { byType[c.type] = []; order.push(c.type); } byType[c.type].push(c); });
    var budget = 48;
    for (var oi = 0; oi < order.length && budget > 0; oi++) {
      var type = order[oi], items = byType[type];
      var grp = fsFrame(type, 'VERTICAL', 10, 0);
      grp.appendChild(await fsText(type + ' — ' + items.length + ' variant(s)', 16, 600, FS_INK));
      var crow = fsWrapRow(type + ' variants', INNER, 20);
      for (var ji = 0; ji < Math.min(8, items.length) && budget > 0; ji++, budget--) {
        try {
          var it = items[ji], stl = it.sample.styles || {};
          var comp = figma.createFrame();
          comp.name = type + '/' + (ji + 1);
          comp.layoutMode = 'HORIZONTAL'; comp.primaryAxisSizingMode = 'AUTO'; comp.counterAxisSizingMode = 'AUTO';
          comp.primaryAxisAlignItems = 'CENTER'; comp.counterAxisAlignItems = 'CENTER';
          comp.paddingTop = fsPx(stl.paddingTop); comp.paddingBottom = fsPx(stl.paddingBottom); comp.paddingLeft = fsPx(stl.paddingLeft); comp.paddingRight = fsPx(stl.paddingRight);
          comp.cornerRadius = /%/.test(stl.borderTopLeftRadius || '') ? 999 : Math.min(999, fsPx(stl.borderTopLeftRadius));
          var bg = fsParseColor(stl.backgroundColor); comp.fills = bg ? [fsSolid(bg)] : [];
          if (fsPx(stl.borderTopWidth) > 0 && stl.borderTopStyle !== 'none') { var bc = fsParseColor(stl.borderTopColor); if (bc) { comp.strokes = [fsSolid(bc)]; comp.strokeWeight = fsPx(stl.borderTopWidth); } }
          var tc = fsParseColor(stl.color) || FS_INK;
          var label = (it.sample.text || type).slice(0, 40);
          comp.appendChild(await fsText(label, fsPx(stl.fontSize) || 14, stl.fontWeight, tc, String(stl.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim()));
          var wrap = fsFrame(type + ' ' + (ji + 1), 'VERTICAL', 6, 12);
          wrap.fills = [fsSolid({ r: 0.98, g: 0.98, b: 0.98, a: 1 })]; wrap.cornerRadius = 10; wrap.strokes = [fsSolid({ r: 0.89, g: 0.89, b: 0.91, a: 1 })]; wrap.strokeWeight = 1;
          wrap.appendChild(comp);
          wrap.appendChild(await fsText(it.sample.size.width + '×' + it.sample.size.height + ' · pad ' + stl.paddingTop + ' ' + stl.paddingRight + ' · radius ' + stl.borderTopLeftRadius + ' · ×' + it.count, 10, 400, FS_MUTED));
          crow.appendChild(wrap); stats.components++;
        } catch (e) { /* skip this variant */ }
      }
      grp.appendChild(crow); cp.appendChild(grp);
    }
    doc.appendChild(cp);
  }
  // Icons
  if ((d.icons || []).length) {
    var ic = fsFrame('Icons', 'VERTICAL', 16, 0);
    ic.appendChild(await fsHeading('Icons', d.icons.length + ' unique inline SVG icons'));
    var ig = fsWrapRow('icons', INNER, 16);
    for (var ki = 0; ki < Math.min(48, d.icons.length); ki++) {
      try { var node = figma.createNodeFromSvg(d.icons[ki].html); node.name = 'icon ' + (ki + 1); ig.appendChild(node); } catch (e) { /* invalid svg */ }
    }
    ic.appendChild(ig); doc.appendChild(ic);
  }
  section.appendChild(doc);
  doc.x = 60; doc.y = 100;
  section.resizeWithoutConstraints(doc.width + 120, doc.height + 160);
  return section;
}

// ---- Automatic paste of the editable layers (ui.html drives it; the local server
// clicks the canvas and presses Cmd+V). PREP makes an empty Section where the
// layers will land, SELECT selects it (API selection keeps the canvas focus),
// COUNT reports how much has arrived, FIT sizes the Section around the result.
// Top-level node ids that existed before the automatic paste, per layers Section.
// Figma does not paste fiGapture layers INTO the selected Section: it creates a new
// top-level frame ("<site> — Figma page"). Anything new on the page is the paste.
var fsLayersBefore = {};
function fsNewTopLevel(sec) {
  var before = fsLayersBefore[sec.id] || {};
  return sec.parent.children.filter(function (n) {
    return n.id !== sec.id && !before[n.id] && !/^⟡/.test(n.name);
  });
}
// Figma's HTML paste leaves an invisible "Sticky placeholder – …" frame on the page for position:sticky
// elements (a size spacer). Remove it, but only when it is really empty and draws nothing.
function fsDropSpacer(n) {
  if (n.type !== 'FRAME' || !/^Sticky placeholder/.test(n.name) || n.children.length) return false;
  var shows = function (a) { return a === figma.mixed || (a || []).some(function (p) { return p.visible !== false; }); };
  if (shows(n.fills) || shows(n.strokes) || shows(n.effects)) return false;
  n.remove();
  return true;
}
// Section backgrounds by level (0 = master, 1 = website, 2 = layers / screenshots / design system):
// each level is one step lighter than the one around it, on dark and on light canvases.
function fsTint(sec, level, page) {
  var bg = (page.backgrounds || [])[0], k = bg && bg.type === 'SOLID' ? bg.color : { r: 0.12, g: 0.12, b: 0.12 };
  var dark = 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b < 0.5;
  var v = (dark ? [0.17, 0.25, 0.34] : [0.84, 0.91, 0.98])[level];
  sec.fills = [{ type: 'SOLID', color: { r: v, g: v, b: v } }];
}
// Lay a Section's children out in one top-aligned row (left to right) and size the Section around them.
function fsRow(sec, pad, top, gap) {
  var x = pad, h = 0;
  sec.children.forEach(function (n) { n.x = x; n.y = top; x += n.width + gap; h = Math.max(h, n.height); });
  sec.resizeWithoutConstraints(Math.max(400, x - gap + pad), Math.max(300, top + h + pad));
}
// Move the pasted top-level frame(s) into the Section and size the Section around them.
function fsFit(sec, name, removeIfEmpty) {
  fsNewTopLevel(sec).forEach(function (n) { if (!fsDropSpacer(n)) sec.appendChild(n); });
  if (!sec.children.length) { delete fsLayersBefore[sec.id]; if (removeIfEmpty) sec.remove(); return { empty: true }; }
  fsRow(sec, 80, 80, 80);
  sec.name = name || sec.name;
  return { width: sec.width, height: sec.height, top: sec.children.length };
}

// ---- Grouping: one Section per website; several websites in one paste -> one master Section around them.
// session: { page, name, x, y, pages: [{ name, host, docW, docH }], sites: [{ host, layers, parts: [], sec }], master }
var fsSessions = {}; // layers Section waiting for a manual Cmd+V -> its session
// Give every pasted page frame in `container` to its website's own "Figma layers" Section.
function fsDistribute(container, session) {
  var bySite = {}; session.sites.forEach(function (s) { bySite[s.host] = s; });
  var frames = container.children.slice(), owner = {}, used = {}, left = [];
  session.pages.forEach(function (pg) {
    for (var i = 0; i < frames.length; i++) if (!used[frames[i].id] && frames[i].name === pg.name) { used[frames[i].id] = 1; owner[frames[i].id] = pg.host; return; }
    left.push(pg);
  });
  left.forEach(function (pg) {
    var f = fgPickFrame(frames.filter(function (n) { return n.type === 'FRAME' && !/^Sticky placeholder/.test(n.name); }), used, pg);
    if (f) { used[f.id] = 1; owner[f.id] = pg.host; }
  });
  // Extra frames Figma makes while pasting: they belong to the page created just before them.
  var num = function (n) { return parseInt(String(n.id).split(':')[1], 10) || 0; };
  var fallback = session.pages.length ? session.pages[0].host : session.sites[0].host;
  frames.forEach(function (n) {
    if (owner[n.id]) return;
    var best = null;
    frames.forEach(function (f) { if (used[f.id] && num(f) < num(n) && (!best || num(f) > num(best))) best = f; });
    owner[n.id] = best ? owner[best.id] : fallback;
  });
  session.sites.forEach(function (site) {
    var mine = frames.filter(function (n) { return owner[n.id] === site.host; });
    if (!mine.length) return;
    var sec = site.layers && !site.layers.removed ? site.layers : null;
    if (!sec) { sec = figma.createSection(); session.page.appendChild(sec); sec.name = 'Figma layers — ' + site.host; site.layers = sec; }
    mine.forEach(function (n) { sec.appendChild(n); });
    fsRow(sec, 80, 80, 80);
  });
  if (!container.removed && !container.children.length) container.remove();
}
// Build (or refresh) the website Sections and the master Section. Safe to call again.
function fsArrange(session) {
  var live = [];
  session.sites.forEach(function (site) {
    var parts = (site.layers && !site.layers.removed ? [site.layers] : []).concat(site.parts.filter(function (n) { return !n.removed; }));
    if (!parts.length) return;
    if (!site.sec || site.sec.removed) { site.sec = figma.createSection(); session.page.appendChild(site.sec); site.sec.name = site.host; }
    parts.forEach(function (n) { site.sec.appendChild(n); if (n.type === 'SECTION') fsTint(n, 2, session.page); }); // order: layers | screenshots | design system
    fsTint(site.sec, 1, session.page);
    fsRow(site.sec, 120, 160, 200);
    live.push(site.sec);
  });
  if (!live.length) return null;
  var root = live[0];
  if (live.length > 1) {
    if (!session.master || session.master.removed) { session.master = figma.createSection(); session.page.appendChild(session.master); }
    session.master.name = session.name + ' (' + live.length + ' websites)';
    root = session.master;
    live.forEach(function (n) { root.appendChild(n); });
    fsTint(root, 0, session.page);
    fsRow(root, 200, 260, 300);
  }
  root.x = session.x; root.y = session.y;
  return root;
}
async function fiGaptureLayers(msg) {
  var reply = function (o) { figma.ui.postMessage(Object.assign({ type: 'FIGAPTURE_LAYERS_RESULT', op: msg.type }, o)); };
  try {
    var sec = msg.id ? await figma.getNodeByIdAsync(msg.id) : null;
    if (msg.type === 'FIGAPTURE_LAYERS_PREP') {
      var page = figma.currentPage, x0 = 0, y0 = 0;
      if (page.children.length) {
        var maxR = -Infinity, minY = Infinity;
        page.children.forEach(function (n) { maxR = Math.max(maxR, n.x + n.width); minY = Math.min(minY, n.y); });
        x0 = maxR + 400; y0 = minY;
      }
      sec = figma.createSection();
      sec.name = msg.name || 'Figma layers';
      sec.x = x0; sec.y = y0;
      sec.resizeWithoutConstraints(1600, 1200);
      var before = {}; page.children.forEach(function (n) { before[n.id] = 1; });
      fsLayersBefore[sec.id] = before;
      // Nothing selected while the server clicks the canvas (a click on a selected
      // node can grab its handles); the view shows the empty Section.
      figma.currentPage.selection = [];
      figma.viewport.scrollAndZoomIntoView([sec]);
      reply({ ok: true, id: sec.id, fileName: figma.root.name, fileKey: figma.fileKey || null });
      return;
    }
    if (!sec || sec.removed || sec.type !== 'SECTION') { reply({ ok: false, error: 'The layers Section is gone.' }); return; }
    if (msg.type === 'FIGAPTURE_LAYERS_SELECT') { figma.currentPage.selection = [sec]; reply({ ok: true }); return; }
    if (msg.type === 'FIGAPTURE_LAYERS_COUNT') {
      // Layers inside the Section plus layers in new top-level nodes (where Figma puts the paste).
      var roots = sec.children.concat(fsNewTopLevel(sec)), n = 0;
      roots.forEach(function (r) { n += 1; try { if (r.findAll) n += r.findAll(function () { return true; }).length; } catch (e) {} });
      var got = {}; roots.forEach(function (r) { got[r.name] = (got[r.name] || 0) + 1; });
      var pages = 0; (msg.names || []).forEach(function (nm) { if (got[nm]) { got[nm]--; pages++; } });
      reply({ ok: true, top: roots.length, count: n, pages: pages });
      return;
    }
    if (msg.type === 'FIGAPTURE_LAYERS_FIT') {
      var fitted = fsFit(sec, msg.name, msg.removeIfEmpty);
      reply(Object.assign({ ok: true }, fitted));
      return;
    }
    if (msg.type === 'FIGAPTURE_LAYERS_FIX') { await fsFixLayers(sec, msg, reply); return; }
    reply({ ok: false, error: 'unknown step' });
  } catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
}

// ---- BEGIN fiGapture post-paste fixes (gradients, video first frame, box pinning) ----
// Figma turns the captured page into layers on Cmd+V. These helpers then (1) put real gradient
// fills on elements whose page background is a CSS gradient, (2) add the first frame of every
// <video> (and the picture of every <canvas>) as an image, (3) move/resize layer boxes so they
// match the page's real boxes. Layers are matched to page elements by position + size.
function fgNum(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
function fgClamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
// Split "a, b(c, d), e" at top-level commas (or another separator char).
function fgSplitTop(str, sep) {
  var out = [], depth = 0, cur = '';
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}
function fgLin2Srgb(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return fgClamp01(c); }
function fgOklab(L, a, b, alpha) {
  var l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return { r: fgLin2Srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g: fgLin2Srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), b: fgLin2Srgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), a: alpha };
}
var FG_NAMED = { white: [1, 1, 1], black: [0, 0, 0], red: [1, 0, 0], green: [0, 0.5019607843, 0], blue: [0, 0, 1], yellow: [1, 1, 0], gray: [0.5019607843, 0.5019607843, 0.5019607843], grey: [0.5019607843, 0.5019607843, 0.5019607843], orange: [1, 0.6470588235, 0], purple: [0.5019607843, 0, 0.5019607843], pink: [1, 0.7529411765, 0.7960784314], cyan: [0, 1, 1], magenta: [1, 0, 1] };
// Any CSS colour Chrome can report in a computed style -> {r,g,b,a} (0..1), or null.
function fgColor(str) {
  if (!str) return null;
  str = String(str).trim().toLowerCase();
  if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (FG_NAMED[str]) return { r: FG_NAMED[str][0], g: FG_NAMED[str][1], b: FG_NAMED[str][2], a: 1 };
  var m = str.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    var h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = str.match(/^([a-z0-9]+)\(\s*(.*)\)$/);
  if (!m) return null;
  var fn = m[1], body = m[2];
  var alpha = 1, main = body;
  var si = body.indexOf('/');
  if (si >= 0) { var at = body.slice(si + 1).trim(); main = body.slice(0, si); alpha = at.indexOf('%') >= 0 ? parseFloat(at) / 100 : parseFloat(at); }
  var parts = main.replace(/,/g, ' ').trim().split(/\s+/);
  if ((fn === 'rgb' || fn === 'rgba') && parts.length >= 3) {
    if (si < 0 && parts.length >= 4) { alpha = parts[3].indexOf('%') >= 0 ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]); }
    var ch = parts.slice(0, 3).map(function (p) { return p.indexOf('%') >= 0 ? parseFloat(p) / 100 : parseFloat(p) / 255; });
    if (ch.some(isNaN)) return null;
    return { r: fgClamp01(ch[0]), g: fgClamp01(ch[1]), b: fgClamp01(ch[2]), a: isNaN(alpha) ? 1 : fgClamp01(alpha) };
  }
  if ((fn === 'hsl' || fn === 'hsla') && parts.length >= 3) {
    if (si < 0 && parts.length >= 4) { alpha = parts[3].indexOf('%') >= 0 ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]); }
    var hh = ((parseFloat(parts[0]) % 360) + 360) % 360, ss = parseFloat(parts[1]) / 100, ll = parseFloat(parts[2]) / 100;
    var k = function (n) { return (n + hh / 30) % 12; }, aa = ss * Math.min(ll, 1 - ll);
    var f = function (n) { return ll - aa * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return { r: fgClamp01(f(0)), g: fgClamp01(f(8)), b: fgClamp01(f(4)), a: isNaN(alpha) ? 1 : fgClamp01(alpha) };
  }
  if (fn === 'color' && parts.length >= 4) {
    var space = parts[0], v3 = parts.slice(1, 4).map(function (p) { return p.indexOf('%') >= 0 ? parseFloat(p) / 100 : parseFloat(p); });
    if (v3.some(isNaN)) return null;
    if (space === 'srgb' || space === 'display-p3') return { r: fgClamp01(v3[0]), g: fgClamp01(v3[1]), b: fgClamp01(v3[2]), a: isNaN(alpha) ? 1 : fgClamp01(alpha) }; // P3 shown as sRGB (close enough)
    if (space === 'srgb-linear') return { r: fgLin2Srgb(v3[0]), g: fgLin2Srgb(v3[1]), b: fgLin2Srgb(v3[2]), a: isNaN(alpha) ? 1 : fgClamp01(alpha) };
    return null;
  }
  if ((fn === 'oklab' || fn === 'oklch') && parts.length >= 3) {
    var L = parts[0].indexOf('%') >= 0 ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    var p1 = parseFloat(parts[1]), p2 = parseFloat(parts[2]);
    if (isNaN(L) || isNaN(p1) || isNaN(p2)) return null;
    if (fn === 'oklab') return fgOklab(L, p1, p2, isNaN(alpha) ? 1 : fgClamp01(alpha));
    var rad = p2 * Math.PI / 180;
    return fgOklab(L, p1 * Math.cos(rad), p1 * Math.sin(rad), isNaN(alpha) ? 1 : fgClamp01(alpha));
  }
  return null;
}
// "rgb(1, 2, 3) 20% 40%" -> { c, pos:[{v,u}] }. A lone length is a colour hint -> { hint:true }.
function fgParseStop(arg) {
  var m = arg.match(/^(rgba?\([^)]*\)|hsla?\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*(.*)$/);
  if (!m) {
    if (/^-?[\d.]+(%|px)?$/.test(arg)) return { hint: true };
    return null;
  }
  var c = fgColor(m[1]);
  if (!c) return null;
  var pos = [];
  var toks = m[2].trim() === '' ? [] : m[2].trim().split(/\s+/);
  for (var i = 0; i < toks.length && pos.length < 2; i++) {
    var t = toks[i].match(/^(-?[\d.]+)(%|px)?$/);
    if (!t) return null;
    pos.push({ v: parseFloat(t[1]), u: t[2] === '%' ? '%' : 'px' });
  }
  return { c: c, pos: pos };
}
// One background-image value -> layers, top (first) to bottom. Unknown pieces become { kind:'other' }.
function fgParseBgImage(str) {
  var out = [];
  if (!str || str === 'none') return out;
  fgSplitTop(str, ',').forEach(function (layer) {
    var m = layer.match(/^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/);
    if (!m) { out.push({ kind: /^url\(/.test(layer) ? 'url' : 'other' }); return; }
    var kind = m[2], repeating = !!m[1];
    var args = fgSplitTop(m[3], ',');
    var cfg = null, first = args[0] || '';
    var firstStop = fgParseStop(first);
    if (!firstStop || firstStop.hint) { cfg = first; args = args.slice(1); }
    var stops = [], bad = false;
    args.forEach(function (a) { var s = fgParseStop(a); if (!s) bad = true; else if (!s.hint) stops.push(s); });
    if (bad || stops.length < 2) { out.push({ kind: 'other' }); return; }
    out.push({ kind: kind, repeating: repeating, cfg: cfg, stops: stops });
  });
  return out;
}
// Resolve stop positions to 0..1 along a line of length `len` (px); fix transparent colours; clip to 0..1.
function fgResolveStops(stops, len) {
  var arr = [];
  stops.forEach(function (s) {
    var ps = s.pos.length ? s.pos : [null];
    ps.forEach(function (p) { arr.push({ c: { r: s.c.r, g: s.c.g, b: s.c.b, a: s.c.a }, p: p === null ? null : (p.u === '%' ? p.v / 100 : (len > 0 ? p.v / len : 0)) }); });
  });
  if (arr[0].p === null) arr[0].p = 0;
  if (arr[arr.length - 1].p === null) arr[arr.length - 1].p = 1;
  var i = 0;
  while (i < arr.length) {
    if (arr[i].p !== null) { i++; continue; }
    var j = i; while (arr[j].p === null) j++;
    var a = arr[i - 1].p, b = arr[j].p, n = j - i + 1;
    for (var k = i; k < j; k++) arr[k].p = a + (b - a) * (k - i + 1) / n;
    i = j;
  }
  var maxP = -Infinity;
  arr.forEach(function (s) { if (s.p < maxP) s.p = maxP; maxP = s.p; });
  // CSS blends in premultiplied colour; Figma does not: a fully transparent stop takes its neighbour's colour.
  for (i = 0; i < arr.length; i++) {
    if (arr[i].c.a > 0.001) continue;
    var near = null;
    for (var d = 1; d < arr.length && !near; d++) { if (arr[i + d] && arr[i + d].c.a > 0.001) near = arr[i + d]; else if (arr[i - d] && arr[i - d].c.a > 0.001) near = arr[i - d]; }
    if (near) { arr[i].c.r = near.c.r; arr[i].c.g = near.c.g; arr[i].c.b = near.c.b; }
  }
  var colorAt = function (t) {
    for (var q = 0; q < arr.length - 1; q++) {
      if (t >= arr[q].p && t <= arr[q + 1].p) {
        var span = arr[q + 1].p - arr[q].p, f = span <= 0 ? 1 : (t - arr[q].p) / span, A = arr[q].c, B = arr[q + 1].c;
        return { r: A.r + (B.r - A.r) * f, g: A.g + (B.g - A.g) * f, b: A.b + (B.b - A.b) * f, a: A.a + (B.a - A.a) * f };
      }
    }
    return t < arr[0].p ? arr[0].c : arr[arr.length - 1].c;
  };
  var res = [];
  if (arr[0].p > 0) res.push({ position: 0, color: arr[0].c });
  var lo = arr[0].p < 0, hi = arr[arr.length - 1].p > 1;
  if (lo) res.push({ position: 0, color: colorAt(0) });
  arr.forEach(function (s) { if (s.p >= 0 && s.p <= 1) res.push({ position: s.p, color: s.c }); });
  if (hi) res.push({ position: 1, color: colorAt(1) });
  if (arr[arr.length - 1].p < 1) res.push({ position: 1, color: arr[arr.length - 1].c });
  // Figma wants at most 8+ stops without trouble, but keeps any number; guarantee ascending order.
  res.sort(function (x, y) { return x.position - y.position; });
  return res;
}
// Background tile box (px, relative to the element) from background-size / position / repeat (one layer).
function fgTile(W, H, size, pos, rep) {
  var tw = W, th = H;
  var sz = (size || 'auto').trim();
  if (sz !== 'auto' && sz !== 'cover' && sz !== 'contain') {
    var t = sz.split(/\s+/);
    var one = function (tok, full) { if (!tok || tok === 'auto') return full; return tok.indexOf('%') >= 0 ? full * parseFloat(tok) / 100 : fgNum(tok); };
    tw = one(t[0], W); th = one(t[1] || 'auto', H);
    if (!isFinite(tw)) tw = W;
    if (!isFinite(th)) th = H;
  }
  var p = (pos || '0% 0%').trim().split(/\s+/);
  var axis = function (tok, free) {
    if (tok === 'left' || tok === 'top') return 0;
    if (tok === 'right' || tok === 'bottom') return free;
    if (tok === 'center' || tok === undefined) return free / 2;
    return tok.indexOf('%') >= 0 ? free * parseFloat(tok) / 100 : fgNum(tok);
  };
  var tx = axis(p[0], W - tw), ty = axis(p[1], H - th);
  // A tile smaller than the box that repeats cannot be one gradient paint.
  var rp = (rep || 'repeat').trim().split(/\s+/), repX, repY;
  if (rp[0] === 'repeat-x') { repX = true; repY = false; }
  else if (rp[0] === 'repeat-y') { repX = false; repY = true; }
  else { repX = rp[0] !== 'no-repeat'; repY = (rp[1] || rp[0]) !== 'no-repeat'; }
  return { x: tx, y: ty, w: tw, h: th, tiled: (repX && tw < W - 0.5) || (repY && th < H - 0.5), part: tx > 0.5 || ty > 0.5 || tx + tw < W - 0.5 || ty + th < H - 0.5 };
}
// One parsed gradient layer + element size -> a Figma paint, or null when it can't be reproduced.
function fgPaint(layer, W, H, tile) {
  if (!layer || layer.repeating || layer.kind === 'conic' || layer.kind === 'other' || layer.kind === 'url') return null;
  if (!(W > 0 && H > 0) || !tile || tile.tiled || tile.part || !(tile.w > 0 && tile.h > 0)) return null;
  var tx = tile.x, ty = tile.y, tw = tile.w, th = tile.h, cx = tx + tw / 2, cy = ty + th / 2, cfg = (layer.cfg || '').toLowerCase().trim();
  var t, stops;
  if (layer.kind === 'linear') {
    var dx = 0, dy = 1;
    var am = cfg.match(/^(-?[\d.]+)(deg|rad|turn|grad)$/);
    if (am) {
      var deg = parseFloat(am[1]) * (am[2] === 'rad' ? 180 / Math.PI : am[2] === 'turn' ? 360 : am[2] === 'grad' ? 0.9 : 1), r = deg * Math.PI / 180;
      dx = Math.sin(r); dy = -Math.cos(r);
    } else if (/^to\s/.test(cfg)) {
      var w = cfg.replace(/^to\s+/, '').split(/\s+/), hx = w.indexOf('right') >= 0 ? 1 : (w.indexOf('left') >= 0 ? -1 : 0), vy = w.indexOf('bottom') >= 0 ? 1 : (w.indexOf('top') >= 0 ? -1 : 0);
      if (hx && vy) { // corner: the 50% line runs through the other two corners
        var vx = th * hx, vyy = tw * vy, mag = Math.sqrt(vx * vx + vyy * vyy); dx = vx / mag; dy = vyy / mag;
      } else { dx = hx; dy = vy; }
    } else if (cfg) return null;
    var L = Math.abs(tw * dx) + Math.abs(th * dy);
    if (!(L > 0)) return null;
    var nx = -dy, ny = dx, p0x = cx - dx * L / 2, p0y = cy - dy * L / 2;
    t = [[W * dx / L, H * dy / L, -(p0x * dx + p0y * dy) / L], [W * nx / L, H * ny / L, 0.5 - (cx * nx + cy * ny) / L]];
    stops = fgResolveStops(layer.stops, L);
    return { type: 'GRADIENT_LINEAR', gradientTransform: t, gradientStops: stops, opacity: 1, visible: true, blendMode: 'NORMAL' };
  }
  // radial
  var shape = /circle/.test(cfg) ? 'circle' : 'ellipse';
  var cpx = cx, cpy = cy, atIdx = cfg.indexOf('at ');
  var head = atIdx >= 0 ? cfg.slice(0, atIdx).trim() : cfg, tail = atIdx >= 0 ? cfg.slice(atIdx + 3).trim() : '';
  if (tail) {
    var pt = tail.split(/\s+/), ax = pt[0], ay = pt[1];
    var coord = function (tok, off, size) { if (tok === 'left' || tok === 'top') return off; if (tok === 'right' || tok === 'bottom') return off + size; if (tok === 'center') return off + size / 2; return tok.indexOf('%') >= 0 ? off + size * parseFloat(tok) / 100 : off + fgNum(tok); };
    if (pt.length === 1) {
      if (ax === 'top' || ax === 'bottom') { cpy = coord(ax, ty, th); } else cpx = coord(ax, tx, tw);
    } else {
      // "top left" order is allowed in CSS: keywords decide the axis.
      if (ax === 'top' || ax === 'bottom' || ay === 'left' || ay === 'right') { var sw = ax; ax = ay; ay = sw; }
      cpx = coord(ax, tx, tw); cpy = coord(ay, ty, th);
    }
  }
  var dl = cpx - tx, dr = tx + tw - cpx, dt = cpy - ty, db = ty + th - cpy;
  var lens = head.replace(/circle|ellipse/g, '').trim(), rx, ry;
  var kw = (lens.match(/closest-side|farthest-side|closest-corner|farthest-corner/) || ['farthest-corner'])[0];
  var lt = lens.replace(kw, '').trim().split(/\s+/).filter(function (z) { return z !== ''; });
  if (lt.length) {
    var one2 = function (tok, full) { return tok.indexOf('%') >= 0 ? full * parseFloat(tok) / 100 : fgNum(tok); };
    rx = one2(lt[0], tw); ry = lt.length > 1 ? one2(lt[1], th) : (shape === 'circle' ? rx : one2(lt[0], th));
    if (shape === 'circle') ry = rx;
  } else if (kw === 'closest-side') { rx = Math.min(dl, dr); ry = Math.min(dt, db); if (shape === 'circle') rx = ry = Math.min(rx, ry); }
  else if (kw === 'farthest-side') { rx = Math.max(dl, dr); ry = Math.max(dt, db); if (shape === 'circle') rx = ry = Math.max(rx, ry); }
  else if (kw === 'closest-corner') {
    if (shape === 'circle') { rx = ry = Math.sqrt(Math.pow(Math.min(dl, dr), 2) + Math.pow(Math.min(dt, db), 2)); }
    else { rx = Math.min(dl, dr) * Math.SQRT2; ry = Math.min(dt, db) * Math.SQRT2; }
  } else {
    if (shape === 'circle') { rx = ry = Math.sqrt(Math.pow(Math.max(dl, dr), 2) + Math.pow(Math.max(dt, db), 2)); }
    else { rx = Math.max(dl, dr) * Math.SQRT2; ry = Math.max(dt, db) * Math.SQRT2; }
  }
  if (!(rx > 0.5)) rx = 0.5; if (!(ry > 0.5)) ry = 0.5;
  t = [[W / (2 * rx), 0, 0.5 - cpx / (2 * rx)], [0, H / (2 * ry), 0.5 - cpy / (2 * ry)]];
  stops = fgResolveStops(layer.stops, Math.max(rx, ry));
  return { type: 'GRADIENT_RADIAL', gradientTransform: t, gradientStops: stops, opacity: 1, visible: true, blendMode: 'NORMAL' };
}
// All fills for an element: [solid background colour, then every layer bottom -> top]. Existing image fills
// (a url() layer the paste already made) are kept at the position of the url() layer. null = nothing to change.
function fgBuildFills(item, W, H, existing) {
  var layers = fgParseBgImage(item.bi);
  if (!layers.some(function (l) { return l.kind === 'linear' || l.kind === 'radial'; })) return null;
  if (item.clip && /text/.test(item.clip)) return null; // gradient text: not a box fill
  var sizes = fgSplitTop(item.size || 'auto', ','), poss = fgSplitTop(item.pos || '0% 0%', ','), reps = fgSplitTop(item.rep || 'repeat', ',');
  var paints = [], madeAny = false;
  var images = (existing || []).filter(function (f) { return f.type === 'IMAGE'; });
  for (var i = layers.length - 1; i >= 0; i--) {
    var l = layers[i];
    if (l.kind === 'linear' || l.kind === 'radial') {
      var tile = fgTile(W, H, sizes[i % sizes.length], poss[i % poss.length], reps[i % reps.length]);
      var p = fgPaint(l, W, H, tile);
      if (p) { paints.push(p); madeAny = true; }
    } else if (l.kind === 'url') { images.forEach(function (im) { paints.push(im); }); images = []; }
  }
  if (!madeAny) return null;
  var out = [];
  var bg = fgColor(item.bg);
  if (bg && bg.a > 0.001) out.push({ type: 'SOLID', color: { r: bg.r, g: bg.g, b: bg.b }, opacity: bg.a, visible: true, blendMode: 'NORMAL' });
  return out.concat(paints).concat(images);
}

// ---- matching page boxes to pasted layers --------------------------------------------------
// boxes: [x, y, w, h, parentIdx, flags, r, g, b, a]  flags: 1 = transformed (don't pin), 2 = has background colour, 8 = virtual (no page element, don't pin)
function fgCollectNodes(root) {
  var list = [], PASS = { FRAME: 1, RECTANGLE: 1, ELLIPSE: 1, INSTANCE: 1, COMPONENT: 1, GROUP: 1, VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1, LINE: 1 };
  var rb = root.absoluteBoundingBox;
  if (!rb) return { list: list, ox: 0, oy: 0 };
  var order = 0;
  var rec = function (n, depth) {
    if (!PASS[n.type]) return;
    var b = n.absoluteBoundingBox;
    if (b && n.visible !== false) list.push({ n: n, x: b.x - rb.x, y: b.y - rb.y, w: b.width, h: b.height, depth: depth, ord: order++, type: n.type });
    if ('children' in n && n.type !== 'INSTANCE') n.children.forEach(function (c) { rec(c, depth + 1); });
  };
  rec(root, 0);
  return { list: list, ox: rb.x, oy: rb.y };
}
function fgFirstSolid(n) {
  var f = n.fills;
  if (!f || f === figma.mixed || !f.length) return null;
  for (var i = f.length - 1; i >= 0; i--) if (f[i].type === 'SOLID' && f[i].visible !== false) return f[i];
  return null;
}
// Greedy one-to-one matching, nearest first. Returns { pairs: {elementIdx: nodeRec}, } 
function fgMatch(boxes, nodes) {
  var CELL = 64, grid = {};
  nodes.forEach(function (nd, i) {
    if (nd.type === 'TEXT') return;
    var key = Math.floor(nd.x / CELL) + ',' + Math.floor(nd.y / CELL);
    (grid[key] = grid[key] || []).push(i);
  });
  // rank inside groups of (almost) identical boxes keeps nested wrappers in order
  var rk = function (x, y, w, h) { return Math.round(x) + ',' + Math.round(y) + ',' + Math.round(w) + ',' + Math.round(h); };
  var eRank = [], nRank = [], gE = {}, gN = {};
  boxes.forEach(function (b, i) { var k = rk(b[0], b[1], b[2], b[3]); gE[k] = (gE[k] || 0); eRank[i] = gE[k]++; });
  nodes.forEach(function (nd, i) { var k = rk(nd.x, nd.y, nd.w, nd.h); gN[k] = (gN[k] || 0); nRank[i] = gN[k]++; });
  var cands = [];
  for (var ei = 0; ei < boxes.length; ei++) {
    var b = boxes[ei], cx0 = Math.floor((b[0] - CELL) / CELL), cx1 = Math.floor((b[0] + CELL) / CELL), cy0 = Math.floor((b[1] - CELL) / CELL), cy1 = Math.floor((b[1] + CELL) / CELL);
    for (var gx = cx0; gx <= cx1; gx++) for (var gy = cy0; gy <= cy1; gy++) {
      var cell = grid[gx + ',' + gy]; if (!cell) continue;
      for (var k = 0; k < cell.length; k++) {
        var nd = nodes[cell[k]];
        var dx = Math.abs(nd.x - b[0]), dy = Math.abs(nd.y - b[1]), dw = Math.abs(nd.w - b[2]), dh = Math.abs(nd.h - b[3]);
        if (dx > 40 || dy > 40 || dw > Math.max(24, 0.2 * b[2]) || dh > Math.max(40, 0.3 * b[3])) continue;
        var sc = dx + dy + dw + dh + 0.02 * Math.abs(eRank[ei] - nRank[cell[k]]);
        var sf = fgFirstSolid(nd.n), hasBg = (b[5] & 2) !== 0;
        if (hasBg && sf) { var bc = Math.abs(sf.color.r - b[6]) + Math.abs(sf.color.g - b[7]) + Math.abs(sf.color.b - b[8]); sc += bc < 0.04 ? -1.5 : 1; }
        else if (hasBg && !sf) sc += 1.5; else if (!hasBg && sf) sc += 1;
        if (sc <= 96) cands.push([sc, ei, cell[k]]);
      }
    }
  }
  cands.sort(function (a, c) { return a[0] - c[0] || a[1] - c[1] || a[2] - c[2]; });
  var usedE = {}, usedN = {}, pairs = {};
  cands.forEach(function (c) {
    if (usedE[c[1]] || usedN[c[2]]) return;
    usedE[c[1]] = 1; usedN[c[2]] = 1; pairs[c[1]] = nodes[c[2]];
  });
  return pairs;
}
function fgAbs(n) { var b = n.absoluteBoundingBox; return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null; }
// Move/resize matched boxes to the page's real boxes (top-down). Returns stats.
function fgPin(boxes, pairs, ox, oy) {
  var st = { matched: 0, adjusted: 0, maxBefore: 0, maxAfter: 0, sumBefore: 0, sumAfter: 0, skipped: 0 };
  var skipSub = {}; // element idx whose subtree is transformed
  // Moving one child of an auto layout frame moves all the others. So every frame on the way to a layer that
  // must move loses its auto layout first (children keep their places); alPage adds auto layout back at the end.
  var freeze = {};
  Object.keys(pairs).forEach(function (k) {
    var b0 = boxes[k], n0 = pairs[k].n, a0 = fgAbs(n0); if (!a0) return;
    if (Math.max(Math.abs(a0.x - ox - b0[0]), Math.abs(a0.y - oy - b0[1]), Math.abs(a0.w - b0[2]), Math.abs(a0.h - b0[3])) <= 0.6) return;
    for (var p0 = n0; p0 && p0.type !== 'SECTION' && p0.type !== 'PAGE'; p0 = p0.parent) { if (freeze[p0.id]) { if (p0 !== n0) break; } freeze[p0.id] = p0; }
  });
  Object.keys(freeze).forEach(function (k) { var f0 = freeze[k]; try { if (f0.layoutMode && f0.layoutMode !== 'NONE') f0.layoutMode = 'NONE'; } catch (e) { /* instance child */ } });
  var idxs = Object.keys(pairs).map(Number).sort(function (a, b) { return pairs[a].ord - pairs[b].ord; });
  idxs.forEach(function (ei) {
    var b = boxes[ei], nd = pairs[ei], n = nd.n;
    st.matched++;
    var a = fgAbs(n); if (!a) return;
    var before = Math.max(Math.abs(a.x - ox - b[0]), Math.abs(a.y - oy - b[1]), Math.abs(a.w - b[2]), Math.abs(a.h - b[3]));
    st.maxBefore = Math.max(st.maxBefore, before); st.sumBefore += before;
    var par = b[4]; var inTf = (b[5] & 1) !== 0 || (par >= 0 && skipSub[par]);
    if (inTf) skipSub[ei] = 1;
    var okType = n.type === 'FRAME' || n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || n.type === 'INSTANCE' || n.type === 'COMPONENT';
    if (inTf || !okType || (b[5] & 8) || n.rotation) { st.skipped++; st.sumAfter += before; st.maxAfter = Math.max(st.maxAfter, before); return; }
    try {
      if (Math.abs(a.w - b[2]) > 0.6 || Math.abs(a.h - b[3]) > 0.6) {
        if ('layoutSizingHorizontal' in n) { try { if (n.layoutSizingHorizontal !== 'FIXED') n.layoutSizingHorizontal = 'FIXED'; if (n.layoutSizingVertical !== 'FIXED') n.layoutSizingVertical = 'FIXED'; } catch (e1) { /* not settable here */ } }
        n.resize(Math.max(0.01, b[2]), Math.max(0.01, b[3]));
      }
      a = fgAbs(n);
      var dx = ox + b[0] - a.x, dy = oy + b[1] - a.y;
      if (Math.abs(dx) > 0.6 || Math.abs(dy) > 0.6) {
        var p = n.parent;
        if (p && 'layoutMode' in p && p.layoutMode !== 'NONE' && n.layoutPositioning !== 'ABSOLUTE') { n.layoutPositioning = 'ABSOLUTE'; a = fgAbs(n); dx = ox + b[0] - a.x; dy = oy + b[1] - a.y; }
        n.x = n.x + dx; n.y = n.y + dy;
      }
      var a2 = fgAbs(n);
      var after = Math.max(Math.abs(a2.x - ox - b[0]), Math.abs(a2.y - oy - b[1]), Math.abs(a2.w - b[2]), Math.abs(a2.h - b[3]));
      if (after < before - 0.01) st.adjusted++;
      st.maxAfter = Math.max(st.maxAfter, after); st.sumAfter += after;
    } catch (e) { st.skipped++; st.sumAfter += before; st.maxAfter = Math.max(st.maxAfter, before); }
  });
  return st;
}
function fgSetRadii(node, r, W, H) {
  var cap = Math.min(W, H) / 2, a = r || [];
  var one = function (v) { v = String(v === undefined ? '0' : v); return Math.max(0, Math.min(cap, /%/.test(v) ? Math.min(W, H) * fgNum(v) / 100 : fgNum(v))); };
  try { node.topLeftRadius = one(a[0]); node.topRightRadius = one(a[1]); node.bottomRightRadius = one(a[2]); node.bottomLeftRadius = one(a[3]); } catch (e) { /* this node has no corner radius */ }
}
// Insert an image layer (video first frame / canvas picture) for page box `b` (document coords).
function fgImageLayer(name, bytes, b, radii, fit, match, rootNode, ox, oy) {
  var img = figma.createImage(bytes);
  var paint = { type: 'IMAGE', imageHash: img.hash, scaleMode: fit === 'contain' || fit === 'scale-down' ? 'FIT' : 'FILL' };
  var n = match && match.n;
  // The paste already made an empty layer for this element: use it.
  if (n && (n.type === 'RECTANGLE' || (n.type === 'FRAME' && n.children.length === 0)) && !n.removed) {
    n.fills = [paint]; n.name = name;
    fgSetRadii(n, radii, n.width, n.height);
    return n;
  }
  var host = n && 'children' in n ? n : (n && n.parent) || rootNode;
  var rect = figma.createRectangle();
  rect.name = name;
  rect.resize(Math.max(0.01, b[2]), Math.max(0.01, b[3]));
  rect.fills = [paint];
  fgSetRadii(rect, radii, b[2], b[3]);
  if (host === (n && n.parent) && n) host.insertChild(host.children.indexOf(n) + 1, rect); else host.insertChild(0, rect);
  if ('layoutMode' in host && host.layoutMode !== 'NONE') { try { rect.layoutPositioning = 'ABSOLUTE'; } catch (e) { /* not an auto-layout child */ } }
  var hb = host.absoluteBoundingBox;
  if (hb) { rect.x = ox + b[0] - hb.x; rect.y = oy + b[1] - hb.y; }
  return rect;
}
function fgNorm(s) { return String(s || '').replace(/[\s\u00a0\u200b]+/g, '').toLowerCase(); }
// texts: [normalised text, x, y, w, h, align, lines] as drawn on the page. Pasted text layers are paired with
// them by their words, in reading order, so the pairing does not depend on where Figma put them.
function fgPairTexts(root, texts) {
  var by = {}, out = [];
  (texts || []).forEach(function (t) { (by[t[0]] = by[t[0]] || []).push(t); });
  var nodes = root.findAllWithCriteria({ types: ['TEXT'] }), seen = {};
  nodes.forEach(function (n) { var k = fgNorm(n.characters); if (k && by[k]) (seen[k] = seen[k] || []).push(n); });
  Object.keys(seen).forEach(function (k) {
    var ns = seen[k], ts = by[k];
    var r = root.absoluteBoundingBox, used = {};
    // The same words several times (menu and footer): pair them from top to bottom, not in layer order.
    if (ns.length === ts.length) {
      var pos = ns.map(function (n) { var a = fgAbs(n) || { x: 0, y: 0 }; return { n: n, x: a.x - r.x, y: a.y - r.y }; });
      var cmp = function (p, q) { return Math.abs(p.y - q.y) > 8 ? p.y - q.y : p.x - q.x; };
      pos.sort(cmp); var tt = ts.map(function (t) { return { t: t, x: t[1], y: t[2] }; }).sort(cmp);
      pos.forEach(function (p, q) { out.push({ n: p.n, t: tt[q].t }); }); return;
    }
    ns.forEach(function (n) {
      var a = fgAbs(n), best = -1, bd = 1200; if (!a) return;
      ts.forEach(function (t, q) { if (used[q]) return; var d = Math.abs(a.x - r.x + a.w / 2 - t[1] - t[3] / 2) + Math.abs(a.y - r.y + a.h / 2 - t[2] - t[4] / 2); if (d < bd) { bd = d; best = q; } });
      if (best >= 0) { used[best] = 1; out.push({ n: n, t: ts[best] }); }
    });
  });
  return out;
}
function fgInter(style) {
  var s = String(style || 'Regular'), it = /italic|oblique/i.test(s), w = 'Regular';
  if (/thin|hairline/i.test(s)) w = 'Thin'; else if (/extra ?light|ultra ?light/i.test(s)) w = 'Extra Light'; else if (/light/i.test(s)) w = 'Light';
  else if (/semi ?bold|demi/i.test(s)) w = 'Semi Bold'; else if (/extra ?bold|ultra ?bold/i.test(s)) w = 'Extra Bold'; else if (/bold/i.test(s)) w = 'Bold';
  else if (/black|heavy/i.test(s)) w = 'Black'; else if (/medium/i.test(s)) w = 'Medium';
  return it ? (w === 'Regular' ? 'Italic' : w + ' Italic') : w;
}
// Fonts this Figma does not have are measured with another font: lines get longer, wrap, and push everything
// below them down. They become Inter (same weight), spaced so that each text is as wide as it is on the page.
async function fgFonts(root, pairs) {
  var st = { replaced: 0, fitted: 0, fonts: {} }, load = {}, sum = {}, todo = [];
  var pt = {}; pairs.forEach(function (p) { pt[p.n.id] = p.t; });
  var key = function (f) { return f.family + '|' + f.style; };
  // 1) read every text once, then load each font once
  root.findAllWithCriteria({ types: ['TEXT'] }).forEach(function (n) {
    if (!n.characters.length) return;
    var t = pt[n.id], missing = n.hasMissingFont;
    if (!missing && !t) return;
    var list; try { list = n.getStyledTextSegments(['fontName', 'fontSize', 'letterSpacing']); } catch (e) { return; }
    list.forEach(function (q) { load[key(q.fontName)] = q.fontName; });
    todo.push({ n: n, t: t, list: list, missing: missing });
  });
  var tryLoad = function (f) { return figma.loadFontAsync(f).then(function () { return true; }, function () { return false; }); };
  var names = Object.keys(load), have = {}, sub = {};
  var got = await Promise.all(names.map(function (k) { return tryLoad(load[k]); }));
  names.forEach(function (k, q) { have[k] = got[q]; });
  var lost = names.filter(function (k) { return !have[k]; });
  await Promise.all(lost.map(function (k) {
    var f = { family: 'Inter', style: fgInter(load[k].style) };
    return tryLoad(f).then(function (ok) { sub[k] = ok ? f : { family: 'Inter', style: 'Regular' }; st.fonts[k] = sub[k].style; return ok || tryLoad(sub[k]); });
  }));
  // 2) work on detached copies: editing and measuring inside the page would lay the whole page out every time
  var em = function (q) { return q.letterSpacing.unit === 'PERCENT' ? q.letterSpacing.value : 100 * q.letterSpacing.value / q.fontSize; };
  var space = function (n, o, add) { o.list.forEach(function (q) { n.setRangeLetterSpacing(q.start, q.end, { unit: 'PERCENT', value: Math.round((em(q) + add) * 100) / 100 }); }); };
  // A text that mixes fonts cannot be changed piece by piece while another piece is still missing:
  // give the whole text one available font first, then every piece its own.
  var refont = function (n, o) {
    var first = null; o.list.forEach(function (q) { if (!first) first = sub[key(q.fontName)] || null; });
    if (!first) return;
    if (o.list.length > 1) n.fontName = first;
    o.list.forEach(function (q) { n.setRangeFontName(q.start, q.end, sub[key(q.fontName)] || q.fontName); });
  };
  var lineH = function (t) { return t[4] / Math.max(1, t[6]); };
  // Line breaks (<br>) that Figma's paste dropped: t[7] = how many visible characters come before each break.
  var breaks = function (n, t) {
    if (!t || !t[7] || !t[7].length) return;
    t[7].slice().sort(function (a, b) { return b - a; }).forEach(function (want) {
      var s = n.characters, seen = 0, i = 0;
      while (i < s.length && seen < want) { if (!/[\s\u00a0\u200b]/.test(s.charAt(i))) seen++; i++; }
      if (seen < want || i >= s.length) return;
      var j = i; while (j < s.length && /[ \u00a0]/.test(s.charAt(j))) j++;
      if (/[\n\u2028]/.test(s.charAt(j)) && t[7].filter(function (w) { return w === want; }).length < 2) return;
      n.insertCharacters(i, '\n', i > 0 ? 'BEFORE' : 'AFTER');
      if (j > i) n.deleteCharacters(i + 1, i + 1 + (j - i));
    });
  };
  var box = figma.createFrame(); box.name = 'fiGapture measuring (temporary)'; box.x = -100000; box.y = -100000;
  try {
    todo.forEach(function (o) {
      o.key = ''; o.list.forEach(function (q) { if (!o.key && sub[key(q.fontName)]) o.key = key(q.fontName); });
      o.mode = o.n.textAutoResize; o.add = null;
      var t = o.t; if (!t || t[6] !== 1 || o.n.characters.length < 2) return;
      try {
        var big = 0, m = o.n.clone(); box.appendChild(m); refont(m, o); if (m.textAutoResize !== 'WIDTH_AND_HEIGHT') m.textAutoResize = 'WIDTH_AND_HEIGHT';
        o.list.forEach(function (q) { big += q.fontSize * (q.end - q.start); });
        var d = t[3] - m.width, add = 100 * d / big; m.remove();
        if (Math.abs(d) <= 0.75) o.add = 0; else if (add > -12 && add < 12) { o.add = add; st.fitted++; }
        if (o.key && o.add !== null && o.n.characters.length > 5) (sum[o.key] = sum[o.key] || []).push(o.add);
      } catch (e) { o.add = null; }
    });
    var med = function (a) { a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; };
    todo.forEach(function (o) {
      if (o.add !== null) return;
      var fam = o.key.split('|')[0], pool = o.key ? (sum[o.key] || [].concat.apply([], Object.keys(sum).filter(function (k) { return k.split('|')[0] === fam; }).map(function (k) { return sum[k]; }))) : [];
      var base = pool.length ? med(pool) : 0, t = o.t; o.add = base;
      if (!t || t[6] < 2 || o.mode !== 'HEIGHT') return;
      try {
        var m = o.n.clone(); box.appendChild(m); refont(m, o); if (base) space(m, o, base); breaks(m, t);
        var tall = t[4] + 0.6 * lineH(t), low = t[4] - 0.6 * lineH(t), add = base, k;
        for (k = 1; k <= 8 && m.height > tall; k++) { add = base - k * 0.5; space(m, o, add); }
        for (k = 1; k <= 6 && add === base && m.height < low; k++) { space(m, o, base + k * 0.5); if (m.height >= low) add = base + k * 0.5; }
        if (m.height <= tall) { if (add !== base) st.fitted++; o.add = add; }
        m.remove();
      } catch (e) { /* keep the base value */ }
    });
  } finally { box.remove(); }
  // 3) apply to the page (no measuring in between)
  todo.forEach(function (o) {
    try {
      if (o.key) { o.n.setPluginData('fgFont', JSON.stringify(o.list.map(function (q) { return q.fontName; }))); refont(o.n, o); st.replaced++; }
      if (o.add && Math.abs(o.add) > 0.01) space(o.n, o, o.add);
      if (o.t && o.t[7] && o.t[7].length && !o.list.some(function (q) { return !have[key(q.fontName)] && !sub[key(q.fontName)]; })) breaks(o.n, o.t);
    } catch (e) { /* not editable */ }
  });
  return st;
}
function fgDrift(p) {
  var a = fgAbs(p.n), t = p.t; if (!a) return null;
  var tall = a.h > t[4] + 0.6 * (t[4] / Math.max(1, t[6]));
  return { x: t[5] === 'center' ? a.x + a.w / 2 - t[1] - t[3] / 2 : (t[5] === 'right' || t[5] === 'end' ? a.x + a.w - t[1] - t[3] : a.x - t[1]), y: tall ? a.y - t[2] : a.y + a.h / 2 - t[2] - t[4] / 2 };
}
async function fgTexts(root, pairs, ox, oy) {
  var st = { matched: pairs.length, moved: 0, unclipped: 0 };
  pairs.forEach(function (p) {
    var n = p.n; if (n.removed || Math.abs(n.rotation || 0) > 0.01) return;
    var d = fgDrift(p); if (!d) return;
    var dx = ox - d.x, dy = oy - d.y;
    if (Math.abs(dy) < 2) dy = 0; if (Math.abs(dx) < 3) dx = 0;
    // Far away and its frame was not placed either: moving only the words would tear the block apart.
    if ((!dx && !dy) || Math.abs(dx) > 160 || Math.abs(dy) > 60) return;
    for (var q = n.parent; q && q.type !== 'SECTION' && q.type !== 'PAGE' && q.layoutMode && q.layoutMode !== 'NONE'; q = q.parent) { try { q.layoutMode = 'NONE'; } catch (e) { break; } }
    try { n.x += dx; n.y += dy; st.moved++; } catch (e) { /* inside an instance */ }
  });
  // A frame that only holds text must not cut its last letter.
  root.findAllWithCriteria({ types: ['FRAME'] }).forEach(function (f) {
    if (!f.clipsContent || !f.children.length) return;
    if (!f.children.every(function (c) { return c.type === 'TEXT'; })) return;
    var over = f.children.some(function (c) { return (c.x + c.width > f.width + 0.2 && c.x + c.width < f.width * 1.3) || (c.y + c.height > f.height + 0.2 && c.y + c.height < f.height + 24); });
    if (over) { f.clipsContent = false; st.unclipped++; }
  });
  return st;
}
// Offset between the page's origin and the pasted frame's origin: vote with the biggest boxes.
function fgOffset(boxes, nodes) {
  var big = [];
  boxes.forEach(function (b, i) { if (b[2] * b[3] >= 6000 && !(b[5] & 8)) big.push(i); });
  big.sort(function (p, q) { return boxes[q][2] * boxes[q][3] - boxes[p][2] * boxes[p][3]; });
  big = big.slice(0, 40);
  var votes = {}, best = null;
  big.forEach(function (i) {
    var b = boxes[i];
    nodes.forEach(function (nd) {
      if (Math.abs(nd.w - b[2]) > 1.5 || Math.abs(nd.h - b[3]) > 1.5) return;
      var dx = Math.round(nd.x - b[0]), dy = Math.round(nd.y - b[1]);
      if (Math.abs(dx) > 400 || Math.abs(dy) > 400) return;
      var k = dx + ',' + dy; votes[k] = (votes[k] || 0) + 1;
      if (!best || votes[k] > votes[best]) best = k;
    });
  });
  if (!best || votes[best] < 3) return { dx: 0, dy: 0, votes: 0 };
  var p = best.split(',');
  return { dx: +p[0], dy: +p[1], votes: votes[best] };
}
// Which top-level pasted frame belongs to this capture? By name, else by size, else by order.
function fgPickFrame(frames, used, pg, order) {
  var i, best = null, bestD = Infinity;
  for (i = 0; i < frames.length; i++) if (!used[frames[i].id] && frames[i].name === pg.name) return frames[i];
  for (i = 0; i < frames.length; i++) {
    if (used[frames[i].id]) continue;
    var d = Math.abs(frames[i].width - pg.docW) + Math.abs(frames[i].height - pg.docH);
    if (d < bestD) { bestD = d; best = frames[i]; }
  }
  if (best && bestD <= Math.max(60, 0.05 * (pg.docW + pg.docH))) return best;
  for (i = 0; i < frames.length; i++) if (!used[frames[i].id]) return frames[i];
  return null;
}
// Apply gradients / video frames / canvas pictures / box pinning to one pasted page frame.
async function fgFixPage(frame, pg, opt) {
  var res = { name: pg.name, boxes: pg.boxes.length, nodes: 0, matched: 0, gradients: 0, gradientsMissed: 0, gradientsSkipped: 0, videos: 0, canvases: 0, pin: null, offset: null };
  var pairsT = fgPairTexts(frame, pg.texts);
  res.fonts = await fgFonts(frame, pairsT);
  var col = fgCollectNodes(frame);
  res.nodes = col.list.length;
  var off = fgOffset(pg.boxes, col.list);
  res.offset = off;
  // Pasted frame origin <-> page origin: shift node coordinates by the voted offset.
  col.list.forEach(function (nd) { nd.x -= off.dx; nd.y -= off.dy; });
  // Match layers where they would be without Figma's drift (a block below a taller text sits lower than on the page).
  var dBy = {}; pairsT.forEach(function (p) { var d = fgDrift(p); if (d) dBy[p.n.id] = { x: d.x - col.ox - off.dx, y: d.y - col.oy - off.dy }; });
  var dNode = {}, dFirst = function (n) { if (dBy[n.id]) return dBy[n.id]; if (!('children' in n)) return null; for (var q = 0; q < n.children.length; q++) { var r = dNode[n.children[q].id] = dFirst(n.children[q]); if (r) { for (q = q + 1; q < n.children.length; q++) dNode[n.children[q].id] = dFirst(n.children[q]); return r; } } return null; };
  dNode[frame.id] = { x: 0, y: 0 }; dFirst(frame);
  col.list.forEach(function (nd) { var d = null; for (var q = nd.n; q && !d; q = q.id === frame.id ? null : q.parent) d = dNode[q.id] || null; if (d && Math.abs(d.x) < 400 && Math.abs(d.y) < 2500) { nd.x -= d.x; nd.y -= d.y; } });
  var pairs = fgMatch(pg.boxes, col.list);
  res.matched = Object.keys(pairs).length;
  var enough = pg.boxes.length > 0 && res.matched >= Math.min(20, pg.boxes.length * 0.3);
  if (opt.pin !== false && enough) {
    res.pin = fgPin(pg.boxes, pairs, col.ox + off.dx, col.oy + off.dy);
    res.texts = await fgTexts(frame, pairsT, col.ox + off.dx, col.oy + off.dy);
  }
  // The page is a window onto its content: it has the page's size and shows nothing outside it (carousels).
  if (pg.docW > 300 && pg.docH > 100) {
    try { if (Math.abs(frame.width - pg.docW) > 0.5 || Math.abs(frame.height - pg.docH) > 0.5) { if (frame.layoutMode !== 'NONE') frame.layoutMode = 'NONE'; frame.resize(pg.docW, pg.docH); } } catch (e) { /* keep */ }
  }
  frame.clipsContent = true;
  var ox = col.ox + off.dx, oy = col.oy + off.dy;
  if (opt.gradients !== false) {
    (pg.grads || []).forEach(function (g) {
      var m = pairs[g.bx];
      if (!m || m.removed || !('fills' in m.n)) { res.gradientsMissed++; return; }
      var n = m.n, cur = n.fills === figma.mixed ? [] : n.fills.slice();
      var fills = fgBuildFills(g, n.width, n.height, cur);
      if (!fills) { res.gradientsSkipped++; return; }
      try { n.fills = fills; res.gradients++; } catch (e) { res.gradientsMissed++; }
    });
  }
  var items = (opt.video !== false ? (pg.videos || []) : []).map(function (v) { return { v: v, name: 'Video (first frame)', key: 'videos' }; })
    .concat((pg.canvases || []).map(function (v) { return { v: v, name: 'Canvas (picture)', key: 'canvases' }; }));
  items.forEach(function (it) {
    try {
      var b = pg.boxes[it.v.bx];
      fgImageLayer(it.name, it.v.bytes, b, it.v.r, it.v.fit, pairs[it.v.bx], frame, ox, oy);
      res[it.key]++;
    } catch (e) { res.error = String(e && e.message || e); }
  });
  return res;
}

// ---- END fiGapture post-paste fixes ----
// ---- BEGIN fiGapture auto layout (every pasted frame gets auto layout, every layer keeps its place) ----
// For a frame without auto layout (or with layers pinned outside the flow) the children's boxes are cut into
// rows and columns; gaps become spacing / padding, and a Row / Column frame is added where one axis is not
// enough. Children that overlap others (backgrounds, badges) become "absolute position" layers inside the
// auto layout parent, which is how Figma stores CSS absolute positioning. Every step is measured and undone
// when a layer would move.
var AL_TOL = 0.5;
var AL_DRAW = { VECTOR: 1, GROUP: 1, BOOLEAN_OPERATION: 1, LINE: 1, STAR: 1, POLYGON: 1, ELLIPSE: 1 };
function alIsAuto(n) { return n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL'; }
function alText(n) { return n.type === 'TEXT' ? 1 : ('findAllWithCriteria' in n ? n.findAllWithCriteria({ types: ['TEXT'] }).length : 0); }
// Target place of every node inside its parent frame: raw (x, y, w, h) and the box it covers (differs when rotated).
function alTarget(n) {
  var t = n.relativeTransform, w = n.width, h = n.height, r = { x: n.x, y: n.y, w: w, h: h, bx: n.x, by: n.y, bw: w, bh: h, rot: Math.abs(n.rotation || 0) > 0.01 };
  if (r.rot && t) {
    var xs = [0, t[0][0] * w, t[0][1] * h, t[0][0] * w + t[0][1] * h], ys = [0, t[1][0] * w, t[1][1] * h, t[1][0] * w + t[1][1] * h];
    r.bx = n.x + Math.min.apply(null, xs); r.by = n.y + Math.min.apply(null, ys);
    r.bw = Math.max.apply(null, xs) - Math.min.apply(null, xs); r.bh = Math.max.apply(null, ys) - Math.min.apply(null, ys);
  }
  return r;
}
function alPaints(n) { var on = function (a) { return a === figma.mixed || (a || []).some(function (p) { return p.visible !== false; }); }; return on(n.fills) || on(n.strokes) || on(n.effects); }
// An invisible wrapper smaller than its content (Figma collapses it when a child leaves the flow) is grown around it.
function alGrow(f, T) {
  var tf = T[f.id]; if (!tf || tf.rot || f.clipsContent || alPaints(f) || f.parent.type !== 'FRAME' || !T[f.parent.id]) return;
  var l = 0, t = 0, r = tf.w, b = tf.h, kids = f.children.filter(function (c) { return c.visible && T[c.id]; });
  kids.forEach(function (c) { var k = T[c.id]; l = Math.min(l, k.bx); t = Math.min(t, k.by); r = Math.max(r, k.bx + k.bw); b = Math.max(b, k.by + k.bh); });
  // Sideways only a little: carousels and marquees are meant to run out of their frame.
  if (l < -80) l = 0; if (r > tf.w + 80) r = tf.w;
  if (l > -0.02 && t > -0.02 && r < tf.w + 0.02 && b < tf.h + 0.02) return;
  kids = f.children.filter(function (c) { return T[c.id]; });
  kids.forEach(function (c) { var k = T[c.id]; k.x -= l; k.y -= t; k.bx -= l; k.by -= t; });
  tf.x += l; tf.y += t; tf.bx += l; tf.by += t; tf.w = tf.bw = r - l; tf.h = tf.bh = b - t; tf.grown = true;
  ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(function (k) { try { if (f[k] !== null) f[k] = null; } catch (e) { /* not available here */ } });
}
function alHit(a, b) { return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > AL_TOL && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > AL_TOL; }
// Split items along one axis wherever a clean gap exists.
function alCut(items, p, s, loose) {
  var arr = items.slice().sort(function (a, b) { return a[p] - b[p] || a[p] + a[s] - b[p] - b[s] || a.i - b.i; }), out = [], end = -Infinity, prev = 0;
  arr.forEach(function (it) {
    if (out.length && it[p] < end - (loose ? Math.min(6, it[s] / 4, prev / 4) : AL_TOL)) out[out.length - 1].push(it); else out.push([it]);
    prev = it[s];
    end = Math.max(end, it[p] + it[s]);
  });
  return out;
}
function alBounds(items) {
  var x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
  items.forEach(function (i) { x = Math.min(x, i.x); y = Math.min(y, i.y); r = Math.max(r, i.x + i.w); b = Math.max(b, i.y + i.h); });
  return { x: x, y: y, w: r - x, h: b - y };
}
// items -> tree { dir, kids, x, y, w, h }; whatever cannot flow is pushed to `abs`.
function alPlan(items, abs) {
  items = items.slice();
  for (;;) {
    if (items.length === 1) return items[0];
    var v = alCut(items, 'y', 'h'), h = alCut(items, 'x', 'w');
    if (v.length < 2 && h.length < 2) { v = alCut(items, 'y', 'h', true); h = alCut(items, 'x', 'w', true); }
    if (v.length > 1 || h.length > 1) {
      var useV = v.length >= h.length, kids = (useV ? v : h).map(function (g) { return alPlan(g, abs); });
      return Object.assign({ dir: useV ? 'VERTICAL' : 'HORIZONTAL', kids: kids }, alBounds(kids));
    }
    var worst = null;
    items.forEach(function (a) {
      var hits = 0; items.forEach(function (b) { if (a !== b && alHit(a, b)) hits++; });
      if (a.t === undefined) a.t = alText(a.n);
      var bad = { it: a, hits: hits, t: a.t, area: a.w * a.h };
      // The layer with the least text leaves the flow (backgrounds, badges, floating buttons).
      if (hits && (!worst || bad.t < worst.t || (bad.t === worst.t && (bad.hits > worst.hits || (bad.hits === worst.hits && bad.area < worst.area))))) worst = bad;
    });
    if (!worst) worst = { it: items[items.length - 1] };
    abs.push(worst.it); items.splice(items.indexOf(worst.it), 1);
  }
}
function alNewFrame(name, dir) {
  var f = figma.createFrame();
  f.name = name; f.fills = []; f.clipsContent = false; f.layoutMode = dir; f.itemSpacing = 0;
  f.paddingLeft = f.paddingRight = f.paddingTop = f.paddingBottom = 0;
  f.primaryAxisSizingMode = 'AUTO'; f.counterAxisSizingMode = 'AUTO';
  return f;
}
// Fill auto layout frame `f` (content box bx,by,bw,bh in the coordinates of the items) with plan `pl`.
function alFill(f, pl, bx, by, bw, bh, st) {
  var V = pl.dir === 'VERTICAL', p = V ? 'y' : 'x', s = V ? 'h' : 'w', cp = V ? 'x' : 'y', cs = V ? 'w' : 'h';
  var kids = pl.kids, b0 = V ? by : bx, bS = V ? bh : bw, c0 = V ? bx : by, cS = V ? bw : bh, pos = function (v) { return Math.max(0, v); };
  var gaps = []; for (var i = 1; i < kids.length; i++) gaps.push(kids[i][p] - kids[i - 1][p] - kids[i - 1][s]);
  var gap = gaps.length ? Math.min.apply(null, gaps) : 0; if (gap < 0) gap = gap < -AL_TOL ? gap : 0;
  var same = function (fn) { var v = kids.map(fn); return Math.max.apply(null, v) - Math.min.apply(null, v) <= 0.1; };
  var minC = Math.min.apply(null, kids.map(function (k) { return k[cp]; })), maxE = Math.max.apply(null, kids.map(function (k) { return k[cp] + k[cs]; }));
  var align = 'MIN', free = false;
  if (same(function (k) { return k[cp]; })) { align = 'MIN'; free = true; }
  else if (same(function (k) { return k[cp] + k[cs] / 2; })) { align = 'CENTER'; free = true; }
  else if (same(function (k) { return k[cp] + k[cs]; })) { align = 'MAX'; free = true; }
  f.itemSpacing = gap;
  var ps = pos(kids[0][p] - b0), pe = pos(b0 + bS - kids[kids.length - 1][p] - kids[kids.length - 1][s]), cps = pos(minC - c0), cpe = pos(c0 + cS - maxE);
  if (V) { f.paddingTop = ps; f.paddingBottom = pe; f.paddingLeft = cps; f.paddingRight = cpe; } else { f.paddingLeft = ps; f.paddingRight = pe; f.paddingTop = cps; f.paddingBottom = cpe; }
  f.primaryAxisAlignItems = 'MIN'; f.counterAxisAlignItems = align;
  // Content that starts outside the frame: centre it, with padding on one side to shift the centre.
  if (kids.length === 1) {
    var k0 = kids[0], skew = function (st0, size, full, a, b) { var d = 2 * st0 + size - full; f[a] = Math.max(0, d); f[b] = Math.max(0, -d); };
    if (k0[p] - b0 < -0.01) { f.primaryAxisAlignItems = 'CENTER'; skew(k0[p] - b0, k0[s], bS, V ? 'paddingTop' : 'paddingLeft', V ? 'paddingBottom' : 'paddingRight'); }
    if (k0[cp] - c0 < -0.01) { f.counterAxisAlignItems = 'CENTER'; skew(k0[cp] - c0, k0[cs], cS, V ? 'paddingLeft' : 'paddingTop', V ? 'paddingRight' : 'paddingBottom'); }
  }
  kids.forEach(function (k, i) {
    var extra = i ? gaps[i - 1] - gap : 0, off = free ? 0 : k[cp] - minC;
    if (extra < 0.1) extra = 0; if (off < 0.1) off = 0;
    var host = f, node = k.n;
    if (k.kids) { // a nested row / column
      node = alNewFrame(k.dir === 'VERTICAL' ? 'Column' : 'Row', k.dir); st.wrappers.push(node);
      f.appendChild(node);
      alFill(node, k, k.x, k.y, k.w, k.h, st);
      // Its own padding carries the extra gap / offset.
      if (extra) { if (V) node.paddingTop += extra; else node.paddingLeft += extra; }
      if (off) { if (V) node.paddingLeft += off; else node.paddingTop += off; }
      return;
    }
    if (extra || off) {
      host = alNewFrame(k.n.name + ' spacing', V ? 'VERTICAL' : 'HORIZONTAL'); st.wrappers.push(host); f.appendChild(host);
      if (V) { host.paddingTop = extra; host.paddingLeft = off; } else { host.paddingLeft = extra; host.paddingTop = off; }
    }
    host.appendChild(node);
    if ('layoutPositioning' in node && node.layoutPositioning !== 'AUTO') node.layoutPositioning = 'AUTO';
  });
}
function alFreeze(n) {
  try { if (n.layoutSizingHorizontal === 'FILL') n.layoutSizingHorizontal = 'FIXED'; } catch (e) { /* not in auto layout */ }
  try { if (n.layoutSizingVertical === 'FILL') n.layoutSizingVertical = 'FIXED'; } catch (e) { /* not in auto layout */ }
}
// Position of node `n` inside frame `f`, through any wrapper frames.
function alRel(n, f) { var x = n.x, y = n.y, p = n.parent; while (p && p.id !== f.id) { x += p.x; y += p.y; p = p.parent; } return { x: x, y: y, w: n.width, h: n.height }; }
function alOff(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h)); }
function alSetMode(f, dir, W, H) {
  alFreeze(f);
  if (f.layoutMode !== 'NONE' && f.layoutMode !== dir) f.layoutMode = 'NONE';
  f.layoutMode = dir;
  if (f.layoutWrap === 'WRAP') f.layoutWrap = 'NO_WRAP';
  f.primaryAxisSizingMode = 'FIXED'; f.counterAxisSizingMode = 'FIXED';
  try { f.strokesIncludedInLayout = false; } catch (e) { /* older API */ }
  try { f.itemReverseZIndex = false; } catch (e) { /* older API */ }
  if (Math.abs(f.width - W) > 0.01 || Math.abs(f.height - H) > 0.01) f.resize(Math.max(0.01, W), Math.max(0.01, H));
}
// Convert one frame. Returns 'flow' | 'absolute' | 'skip'.
function alConvert(f, st, T) {
  var all = f.children.slice(), tf = T[f.id];
  if (!all.length || all.some(function (c) { return c.isMask; })) return 'skip';
  if (all.length > 1 && all.every(function (c) { return AL_DRAW[c.type] && !alText(c); })) { st.drawings++; return 'skip'; } // an icon / illustration
  var W = tf ? tf.w : f.width, H = tf ? tf.h : f.height;
  var inPlace = function () {
    var w = Math.max(Math.abs(f.width - W), Math.abs(f.height - H));
    all.forEach(function (c) { if (c.visible && T[c.id]) w = Math.max(w, alOff(alRel(c, f), T[c.id])); });
    return w;
  };
  if (f.layoutMode !== 'NONE' && !all.some(function (c) { return c.visible && c.layoutPositioning === 'ABSOLUTE'; }) && inPlace() <= 0.05) return 'skip';
  var sizing = null; try { sizing = [f.layoutSizingHorizontal, f.layoutSizingVertical]; } catch (e) { sizing = null; }
  var keep = st.wrappers, worst = 0;
  var placeAbs = function (c) { var b = T[c.id]; if (!b) return; if ('layoutPositioning' in c) c.layoutPositioning = 'ABSOLUTE'; if (Math.abs(c.width - b.w) > 0.01 || Math.abs(c.height - b.h) > 0.01) { try { c.resize(Math.max(0.01, b.w), Math.max(0.01, b.h)); } catch (e) { /* not resizable */ } } c.x = b.x; c.y = b.y; };
  // Try 0: everything that can flows. Try 1: rotated layers and layers outside the frame leave the flow.
  // Try 2: auto layout frame with absolutely positioned children only (always exact).
  for (var tr = 0; tr < 3; tr++) {
    st.wrappers = [];
    var items = [], abs = [], plan = null, isAbs = {};
    all.forEach(function (c, i) {
      var t = T[c.id]; if (!c.visible || !t) return;
      var b = { n: c, i: i, x: t.bx, y: t.by, w: t.bw, h: t.bh };
      var out = tr === 2 || !('layoutPositioning' in c) || (tr === 1 && (t.rot || b.x < -0.01 || b.y < -0.01 || b.x > W || b.y > H));
      (out ? abs : items).push(b);
    });
    try {
      if (items.length) {
        plan = alPlan(items, abs);
        if (!plan.kids || (plan.kids.length > 1 && (plan.x < -0.01 || plan.y < -0.01))) plan = Object.assign({ dir: 'VERTICAL' }, alBounds([plan]), { kids: [plan] });
      }
      abs.forEach(function (b) { isAbs[b.n.id] = b; });
      all.forEach(alFreeze);
      alSetMode(f, plan ? plan.dir : 'VERTICAL', W, H);
      if (!plan) { f.paddingLeft = f.paddingRight = f.paddingTop = f.paddingBottom = 0; f.itemSpacing = 0; f.primaryAxisAlignItems = 'MIN'; f.counterAxisAlignItems = 'MIN'; }
      else {
        alFill(f, plan, 0, 0, W, H, st);
        // Layers order: absolute layers stay below / above the flowing ones they overlap.
        var flow = f.children.filter(function (c) { return !isAbs[c.id]; }), low = [], high = [];
        abs.slice().sort(function (a, b) { return a.i - b.i; }).forEach(function (a) {
          var over = items.filter(function (t) { return !isAbs[t.n.id] && alHit(a, t); });
          var under = over.length ? over.filter(function (t) { return t.i > a.i; }).length >= over.length / 2 : a.i === 0;
          (under ? low : high).push(a.n);
        });
        low.concat(flow, high).forEach(function (c) { f.appendChild(c); });
      }
      abs.forEach(function (b) {
        placeAbs(b.n);
        // A background the size of its parent keeps covering it when the parent grows.
        if ('constraints' in b.n && !T[b.n.id].rot) { try { if (b.y <= 0.5 && b.y + b.h >= H - 0.5 && alIsAuto(b.n) && b.n.layoutSizingVertical === 'HUG') { b.n.layoutSizingVertical = 'FIXED'; b.n.resize(b.w, b.h); } b.n.constraints = { horizontal: b.x <= 0.5 && b.x + b.w >= W - 0.5 ? 'STRETCH' : b.n.constraints.horizontal, vertical: b.y <= 0.5 && b.y + b.h >= H - 0.5 ? 'STRETCH' : b.n.constraints.vertical }; } catch (e) { /* no constraints here */ } }
      });
      // Sizes first (a grown wrapper, a text box), then measure.
      items.forEach(function (b) { if (isAbs[b.n.id]) return; var t = T[b.n.id]; if (Math.abs(b.n.width - t.w) > 0.01 || Math.abs(b.n.height - t.h) > 0.01) { try { b.n.resize(Math.max(0.01, t.w), Math.max(0.01, t.h)); } catch (e) { /* not resizable */ } } });
      worst = inPlace();
    } catch (e) { worst = 1e9; st.errors.push(f.name + ': ' + String(e && e.message || e)); }
    if (worst <= AL_TOL) {
      st.wrappers = keep.concat(st.wrappers); st.newAbs += abs.length;
      alKeepFill(f, sizing, W, H);
      return plan ? 'flow' : 'absolute';
    }
    if (st.trace && st.trace.length < 400) st.trace.push({ try: tr, f: f.name, worst: Math.round(worst * 10) / 10, W: W, H: H, dir: f.layoutMode, al: [f.primaryAxisAlignItems, f.counterAxisAlignItems], kids: all.slice(0, 5).map(function (c) { var r = c.removed ? null : alRel(c, f); return [c.name.slice(0, 20), c.type, T[c.id], r]; }) });
    // Undo: children back in order, helper frames gone.
    all.forEach(function (c) { f.appendChild(c); });
    st.wrappers.forEach(function (w) { if (!w.removed) w.remove(); });
    st.wrappers = keep;
    if (tr === 2) { st.fallbacks.push([f.name, Math.round(worst * 10) / 10]); return 'absolute'; }
    st.retries++;
  }
}
// A frame that filled its parent keeps filling it.
function alKeepFill(f, sizing, W, H) {
  if (!sizing) return;
  ['Horizontal', 'Vertical'].forEach(function (ax, i) {
    if (sizing[i] !== 'FILL') return;
    var k = 'layoutSizing' + ax;
    try { if (f[k] === 'FILL') return; f[k] = 'FILL'; if (Math.abs(f.width - W) > 0.01 || Math.abs(f.height - H) > 0.01) { f[k] = 'FIXED'; f.resize(W, H); } } catch (e) { /* parent has no auto layout yet */ }
  });
}
// Make sizes flexible where that changes nothing now: height hugs the content, full-width children fill.
function alFlex(f, st) {
  if (!alIsAuto(f)) return;
  var kids = f.children.filter(function (c) { return c.visible && c.layoutPositioning !== 'ABSOLUTE'; });
  if (!kids.length) return;
  var W = f.width, H = f.height;
  var snap = f.children.map(function (c) { return { c: c, x: c.x, y: c.y, w: c.width, h: c.height }; });
  var moved = function () { return Math.abs(f.width - W) > 0.02 || Math.abs(f.height - H) > 0.02 || snap.some(function (o) { return Math.abs(o.c.x - o.x) > 0.02 || Math.abs(o.c.y - o.y) > 0.02 || Math.abs(o.c.width - o.w) > 0.02 || Math.abs(o.c.height - o.h) > 0.02; }); };
  var restore = function () { snap.forEach(function (o) { if (o.c.layoutPositioning === 'ABSOLUTE') { o.c.x = o.x; o.c.y = o.y; } }); };
  try {
    if (f.layoutSizingVertical === 'FIXED' && !(f.layoutPositioning === 'ABSOLUTE' && f.constraints && f.constraints.vertical === 'STRETCH')) {
      f.layoutSizingVertical = 'HUG';
      if (moved()) { f.layoutSizingVertical = 'FIXED'; f.resize(W, H); restore(); } else st.hug++;
    }
  } catch (e) { /* not allowed here */ }
  if (f.layoutMode === 'VERTICAL' && f.layoutSizingHorizontal !== 'HUG') {
    var inner = W - f.paddingLeft - f.paddingRight;
    kids.forEach(function (c) {
      if (!alIsAuto(c) || c.layoutSizingHorizontal === 'FILL' || Math.abs(c.width - inner) > 0.02) return;
      var was = c.layoutSizingHorizontal, w = c.width, h = c.height;
      try { c.layoutSizingHorizontal = 'FILL'; if (moved()) { c.layoutSizingHorizontal = was; if (was === 'FIXED') c.resize(w, h); } else st.fill++; } catch (e) { /* not allowed here */ }
    });
  }
}
function alPage(root, opt) {
  var st = { frames: 0, flow: 0, absolute: 0, drawings: 0, newAbs: 0, hug: 0, fill: 0, wrappers: [], fallbacks: [], errors: [], retries: 0, grown: 0, trace: opt && opt.trace ? [] : null, worst: 0, moved: 0 };
  var list = [], base = [], T = {};
  var o = root.absoluteBoundingBox;
  var walk = function (n) {
    var b = n.absoluteBoundingBox;
    if (n !== root) T[n.id] = alTarget(n);
    if (b && n !== root) base.push({ n: n, x: b.x - o.x, y: b.y - o.y, w: b.width, h: b.height });
    if (n.type === 'INSTANCE' || !('children' in n)) return;
    n.children.forEach(walk);
    if (n.type === 'FRAME') list.push(n); // children first
  };
  walk(root);
  list.forEach(function (f) { if (f !== root) alGrow(f, T); }); // children first
  base.forEach(function (b) { b.grown = T[b.n.id] && T[b.n.id].grown; });
  // No pauses in this loop: every pause makes Figma redraw the page, which costs far more than the work itself.
  for (var i = 0; i < list.length; i++) {
    if (list[i].removed) continue;
    st.frames++;
    var r = alConvert(list[i], st, T);
    if (r === 'flow') st.flow++; else if (r === 'absolute') st.absolute++;
  }
  if (!opt || opt.flex !== false) {
    var all = root.findAllWithCriteria({ types: ['FRAME'] }).reverse(); all.push(root);
    var rw = root.width, rh = root.height;
    for (i = 0; i < all.length; i++) { if (!all[i].removed) alFlex(all[i], st); }
    if (Math.abs(root.height - rh) > 0.5 || Math.abs(root.width - rw) > 0.5) { try { root.layoutSizingVertical = 'FIXED'; root.resize(rw, rh); } catch (e) { /* keep */ } }
  }
  var o2 = root.absoluteBoundingBox; st.movedList = [];
  base.forEach(function (b) {
    if (b.n.removed) { st.errors.push('removed'); return; }
    var a = b.n.absoluteBoundingBox; if (!a) return;
    if (b.grown) { st.grown++; return; } // invisible wrapper, resized on purpose
    var d = alOff({ x: a.x - o2.x, y: a.y - o2.y, w: a.width, h: a.height }, b);
    st.worst = Math.max(st.worst, d); if (d > 1) { st.moved++; if (st.movedList.length < 8) st.movedList.push([b.n.name, b.n.type, Math.round(d * 10) / 10]); }
  });
  st.wrappers = st.wrappers.length;
  return st;
}
// ---- END fiGapture auto layout ----

// Apply the fixes to the pasted layers of one or more captured pages (message FIGAPTURE_LAYERS_FIX).
async function fsFixLayers(sec, msg, reply) {
  if (msg.manual) {
    // Layers pasted by hand land as a new top-level frame next to the Section: move them in first.
    var arrived = fsNewTopLevel(sec);
    if (!arrived.length && !sec.children.length) { reply({ ok: false, error: 'No pasted layers found yet. Press Cmd+V first, then try again.' }); return; }
    fsFit(sec, msg.name);
    delete fsLayersBefore[sec.id];
  }
  var frames = sec.children.filter(function (n) { return n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE'; });
  var used = {}, results = [];
  for (var i = 0; i < (msg.pages || []).length; i++) {
    var pg = msg.pages[i], fr = fgPickFrame(frames, used, pg, i);
    if (!fr) { results.push({ name: pg.name, error: 'pasted frame not found' }); continue; }
    used[fr.id] = 1;
    var one;
    try { one = await fgFixPage(fr, pg, msg.options || {}); } catch (e) { one = { name: pg.name, error: String(e && e.message || e) }; }
    // Last step: auto layout everywhere, every layer staying where it is now.
    try { var al = alPage(fr); one.auto = { frames: al.flow, pinned: al.newAbs, moved: al.moved, worst: al.worst }; }
    catch (e) { one.autoError = String(e && e.message || e); }
    results.push(one);
    figma.ui.postMessage({ type: 'FIGAPTURE_FIX_PROGRESS', done: i + 1, total: msg.pages.length });
  }
  // Layers pasted by hand: now move them into their websites' Sections.
  var ses = msg.manual ? fsSessions[sec.id] : null;
  if (ses) {
    delete fsSessions[sec.id];
    try { fsDistribute(sec, ses); var root = fsArrange(ses); if (root) { figma.currentPage.selection = []; figma.viewport.scrollAndZoomIntoView([root]); } }
    catch (e) { results.push({ name: 'grouping', error: 'Grouping into Sections failed: ' + String(e && e.message || e) }); }
  }
  reply({ ok: true, results: results });
}

var fsCreated = [];
async function fiGaptureBuild(msg) {
  fsCreated = [];
  var stats = { pages: 0, designs: 0, components: 0 };
  try {
    await Promise.all(['Regular', 'Medium', 'Semi Bold', 'Bold'].map(function (s) { return figma.loadFontAsync({ family: 'Inter', style: s }); }));
    var page = figma.currentPage;
    var x0 = 0, y0 = 0;
    // Layers already pasted by the automatic paste: put everything else to their right.
    var pasted = msg.layerSectionId ? await figma.getNodeByIdAsync(msg.layerSectionId) : null;
    if (pasted && pasted.type === 'SECTION' && !pasted.removed) {
      // One row, top-aligned, left to right: layers | screenshots | design system.
      x0 = pasted.x + pasted.width + 200; y0 = pasted.y;
    } else if (page.children.length) {
      pasted = null;
      var maxR = -Infinity, minY = Infinity;
      page.children.forEach(function (n) { maxR = Math.max(maxR, n.x + n.width); minY = Math.min(minY, n.y); });
      x0 = maxR + 400; y0 = minY;
    }
    var rowY = y0, layerSection = null;
    var session = {
      page: page, name: msg.sessionName || 'fiGapture session', pages: msg.layerPages || [], master: null,
      sites: msg.sites.map(function (st) { return { host: st.host, layers: null, parts: [], sec: null }; })
    };
    if (msg.hasLayers && !pasted) {
      layerSection = figma.createSection(); fsCreated.push(layerSection);
      layerSection.name = 'Figma layers — paste here with Cmd+V';
      layerSection.x = x0; layerSection.y = rowY;
      layerSection.resizeWithoutConstraints(1600, 1200);
      x0 += 1600 + 200; // same row, to the left of the rest
    }
    session.x = pasted ? pasted.x : x0; session.y = y0;
    // Progress for the panel's loader: one step per page section and per design system.
    var stepTotal = 0, stepDone = 0;
    msg.sites.forEach(function (st) { st.pages.forEach(function (pg) { if (pg.slices && pg.slices.length) stepTotal++; }); if (st.design) stepTotal++; });
    var step = function (label) { figma.ui.postMessage({ type: 'FIGAPTURE_BUILD_PROGRESS', done: stepDone, total: stepTotal, label: label }); };
    for (var si = 0; si < msg.sites.length; si++) {
      var site = msg.sites[si], cx = x0, rowH = 0;
      for (var pi = 0; pi < site.pages.length; pi++) {
        var p = site.pages[pi];
        if (!p.slices || !p.slices.length) continue;
        step('Placing screenshots — ' + site.host + (p.path || ''));
        var sec = await fsBuildPage(site.host, p, cx, rowY);
        session.sites[si].parts.push(sec); stats.pages++; stepDone++;
        cx += sec.width + 200; rowH = Math.max(rowH, sec.height);
      }
      if (site.design) {
        step('Building the design system — ' + site.host);
        var dsec = await fsBuildDesign(site.host, site.design, site.designPages || [], cx, rowY, stats);
        session.sites[si].parts.push(dsec); stats.designs++; stepDone++;
        rowH = Math.max(rowH, dsec.height);
      }
      rowY += rowH + 300;
    }
    // Everything is built: from here on a problem must never delete it (or the pasted layers).
    fsCreated = [];
    var root = null, groupError = '';
    try {
      if (pasted) {
        // Empty spacer frames can appear on the page after the paste was collected.
        if (fsLayersBefore[pasted.id]) fsNewTopLevel(pasted).forEach(function (n) { if (!fsDropSpacer(n) && session.pages.some(function (pg) { return pg.name === n.name; })) pasted.appendChild(n); });
        delete fsLayersBefore[pasted.id];
        fsDistribute(pasted, session);
      }
      root = fsArrange(session);
    } catch (e) { groupError = String(e && e.message || e); }
    var show = [root, layerSection].filter(Boolean);
    if (show.length) figma.viewport.scrollAndZoomIntoView(show);
    if (layerSection) {
      // Remember what is already on the page, so layers pasted by hand later can be found (and fixed) afterwards.
      var seen = {}; page.children.forEach(function (n) { seen[n.id] = 1; });
      fsLayersBefore[layerSection.id] = seen;
      fsSessions[layerSection.id] = session;
      figma.currentPage.selection = [layerSection];
    }
    figma.ui.postMessage({ type: 'FIGAPTURE_BUILD_RESULT', ok: true, stats: stats, groupError: groupError, selectedLayers: !!layerSection, layerSectionId: layerSection ? layerSection.id : null });
  } catch (e) {
    // Undo a half-finished build so no empty Sections or stray styles are left behind.
    fsCreated.forEach(function (n) { try { n.remove(); } catch (err) { /* already gone */ } });
    figma.ui.postMessage({ type: 'FIGAPTURE_BUILD_RESULT', ok: false, error: String(e && e.message || e), stats: stats });
  }
}

// =====================================================================
// Page Transfer (Custom): move pages from this file to another file.
//   A) rebuild: serialize pages here, rebuild them in the destination file,
//      re-linking instances to the published design-system library.
//   B) native: select a page's contents so you can copy/paste natively.
// The plugin API cannot touch two files at once, so the Bridge UI relays the
// data through the local MCP server, which also writes the on-disk backup.
// =====================================================================
var trAckResolve = null;
var trImageAckResolve = null;
var trCancelled = false;
var trImageMap = {};      // source image hash -> created image hash (per destination run)
var trLibCache = {};      // library component key -> ComponentNode | null
var trGlobalVarCache = {};
var trGlobalStyleCache = {};

function withTimeout(promise, ms, desc) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error('Timeout after ' + ms + 'ms for ' + (desc || 'operation')));
    }, ms);
    promise.then(function (res) {
      clearTimeout(timer);
      resolve(res);
    }, function (err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function trYield() {
  if (trCancelled) throw new Error('Cancelled');
  return new Promise(function (r) { setTimeout(r, 0); });
}
function trMixed(v) { return v === figma.mixed; }
function trClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    var arr = new Array(v.length);
    for (var i = 0; i < v.length; i++) arr[i] = trClone(v[i]);
    return arr;
  }
  var obj = {};
  var keys = Object.keys(v);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    obj[key] = trClone(v[key]);
  }
  return obj;
}

// ---------- page list ----------
// Every page is transferable: no page is locked or auto-excluded.
function trIsDivider(n) { return /^[\s\-–—_=*·•.~]*$/.test(String(n || '')); }
async function trListPages() {
  var out = [];
  figma.root.children.forEach(function (p) {
    var itemCount = 0;
    try { itemCount = p.children ? p.children.length : 0; } catch (e) {}
    out.push({ id: p.id, name: p.name, itemCount: itemCount, excluded: false, reason: '', divider: trIsDivider(p.name) });
  });
  return { pages: out, words: [] };
}

// ---------- serializer ----------
async function trVarKey(id, ctx) {
  if (!id) return null;
  if (trGlobalVarCache[id] !== undefined) return trGlobalVarCache[id];
  if (ctx && ctx.varKeys && ctx.varKeys[id] !== undefined) return ctx.varKeys[id];
  var k = null;
  try { var v = await figma.variables.getVariableByIdAsync(id); k = v ? v.key : null; } catch (e) {}
  trGlobalVarCache[id] = k;
  if (ctx && ctx.varKeys) ctx.varKeys[id] = k;
  return k;
}
async function trStyleKey(id, ctx) {
  if (!id || trMixed(id)) return null;
  if (trGlobalStyleCache[id] !== undefined) return trGlobalStyleCache[id];
  if (ctx && ctx.styleKeys && ctx.styleKeys[id] !== undefined) return ctx.styleKeys[id];
  var k = null;
  try { var s = await figma.getStyleByIdAsync(id); k = s ? s.key : null; } catch (e) {}
  trGlobalStyleCache[id] = k;
  if (ctx && ctx.styleKeys) ctx.styleKeys[id] = k;
  return k;
}
async function trPaints(arr, ctx) {
  if (!arr || trMixed(arr) || !arr.length) return null;
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var p = arr[i];
    if (!p) continue;
    var o = { type: p.type };
    if (p.visible === false) o.visible = false;
    if (p.opacity != null && p.opacity !== 1) o.opacity = p.opacity;
    if (p.blendMode && p.blendMode !== 'NORMAL') o.blendMode = p.blendMode;
    if (p.type === 'SOLID') {
      o.color = { r: p.color.r, g: p.color.g, b: p.color.b };
      if (p.boundVariables && p.boundVariables.color) o.bvColor = await trVarKey(p.boundVariables.color.id, ctx);
    } else if (p.type.indexOf('GRADIENT') === 0) {
      o.gradientStops = p.gradientStops.map(function (s) { return { position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } }; });
      o.gradientTransform = p.gradientTransform;
    } else if (p.type === 'IMAGE') {
      o.scaleMode = p.scaleMode; o.imageHash = p.imageHash; o.rotation = p.rotation; o.scalingFactor = p.scalingFactor; o.imageTransform = p.imageTransform; o.filters = p.filters;
      if (p.imageHash) ctx.images[p.imageHash] = 1;
    } else { continue; }
    out.push(o);
  }
  return out.length ? out : null;
}
function trEffects(arr) {
  if (!arr || trMixed(arr) || !arr.length) return null;
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var e = arr[i];
    if (!e || e.visible === false) continue;
    var o = {};
    var keys = Object.keys(e);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (key !== 'boundVariables') o[key] = e[key];
    }
    out.push(o);
  }
  return out.length ? out : null;
}
var TR_PLAIN = ['visible', 'locked', 'opacity', 'blendMode', 'isMask', 'maskType', 'constraints', 'layoutPositioning', 'layoutAlign', 'layoutGrow', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight',
  'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'cornerSmoothing', 'clipsContent',
  'layoutMode', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'itemSpacing', 'counterAxisSpacing', 'layoutWrap', 'itemReverseZIndex', 'strokesIncludedInLayout', 'layoutSizingHorizontal', 'layoutSizingVertical', 'pointCount', 'innerRadius', 'arcData', 'booleanOperation', 'rotation'];
var TR_BV_FIELDS = ['cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'strokeWeight', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'opacity', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'fontSize', 'lineHeight', 'letterSpacing', 'visible', 'characters'];

function isDefaultPlain(k, v, node) {
  if (v === undefined || v === null || trMixed(v)) return true;
  if (k === 'visible' && v === true) return true;
  if (k === 'locked' && v === false) return true;
  if (k === 'opacity' && (v === 1 || Math.abs(v - 1) < 0.0001)) return true;
  if (k === 'blendMode' && (v === 'PASS_THROUGH' || v === 'NORMAL')) return true;
  if (k === 'isMask' && v === false) return true;
  if (k === 'maskType' && v === 'ALPHA') return true;
  if (k === 'layoutMode' && v === 'NONE') return true;
  if (k === 'layoutPositioning' && v === 'AUTO') return true;
  if (k === 'layoutGrow' && v === 0) return true;
  if (k === 'layoutAlign' && v === 'INHERIT') return true;
  if (k === 'rotation' && Math.abs(v) < 0.001) return true;
  if (k === 'cornerSmoothing' && v === 0) return true;
  if (k === 'clipsContent' && v === false) return true;
  if (k === 'strokeWeight' && v === 1 && (!node.strokes || !node.strokes.length)) return true;
  if ((k === 'paddingLeft' || k === 'paddingRight' || k === 'paddingTop' || k === 'paddingBottom' || k === 'itemSpacing' || k === 'counterAxisSpacing') && v === 0) return true;
  if ((k === 'cornerRadius' || k === 'topLeftRadius' || k === 'topRightRadius' || k === 'bottomLeftRadius' || k === 'bottomRightRadius') && v === 0) return true;
  if ((k === 'strokeTopWeight' || k === 'strokeRightWeight' || k === 'strokeBottomWeight' || k === 'strokeLeftWeight') && v === 0) return true;
  return false;
}

async function trSer(node, ctx, isInsideInstance) {
  if (trCancelled) throw new Error('Cancelled');
  ctx.count++;
  if (ctx.count % 100 === 0) await trYield();
  var t = node.type;
  var o = { type: t, name: node.name, id: node.id };
  
  for (var pi = 0; pi < TR_PLAIN.length; pi++) {
    var k = TR_PLAIN[pi];
    if (isInsideInstance && (k === 'constraints' || k === 'layoutAlign' || k === 'layoutGrow' || k === 'layoutMode' || k.indexOf('padding') === 0 || k.indexOf('stroke') === 0 || k.indexOf('Radius') >= 0)) {
      continue;
    }
    try {
      var v = node[k];
      if (!isDefaultPlain(k, v, node)) {
        o[k] = (typeof v === 'object' && v !== null) ? trClone(v) : v;
      }
    } catch (e) {}
  }
  
  try { o.w = node.width; o.h = node.height; if (!isInsideInstance) o.t = node.relativeTransform; } catch (e) {}
  if ('fills' in node && node.fills && node.fills.length) {
    var fls = await trPaints(node.fills, ctx);
    if (fls) o.fills = fls;
  }
  
  if (!isInsideInstance) {
    if ('strokes' in node && node.strokes && node.strokes.length) {
      var stks = await trPaints(node.strokes, ctx);
      if (stks) o.strokes = stks;
    }
    if ('effects' in node && node.effects && node.effects.length) {
      var effs = trEffects(node.effects);
      if (effs) o.effects = effs;
    }
    if ('layoutGrids' in node && node.layoutGrids && node.layoutGrids.length) {
      try { o.layoutGrids = trClone(node.layoutGrids); } catch (e) {}
    }
    try {
      if ('fillStyleId' in node) o.fillStyleKey = await trStyleKey(node.fillStyleId, ctx);
      if ('strokeStyleId' in node) o.strokeStyleKey = await trStyleKey(node.strokeStyleId, ctx);
      if ('effectStyleId' in node) o.effectStyleKey = await trStyleKey(node.effectStyleId, ctx);
      if ('gridStyleId' in node) o.gridStyleKey = await trStyleKey(node.gridStyleId, ctx);
    } catch (e) {}
    if (node.boundVariables) {
      var bvObj = {};
      var bKeys = Object.keys(node.boundVariables);
      for (var bi = 0; bi < bKeys.length; bi++) {
        var f = bKeys[bi], a = node.boundVariables[f];
        if (a && a.id) {
          var vk = await trVarKey(a.id, ctx);
          if (vk) bvObj[f] = vk;
        }
      }
      if (Object.keys(bvObj).length) o.bv = bvObj;
    }
  } else {
    try {
      if ('fillStyleId' in node && node.fillStyleId) o.fillStyleKey = await trStyleKey(node.fillStyleId, ctx);
    } catch (e) {}
  }
  
  if (!isInsideInstance && (t === 'VECTOR' || t === 'LINE' || t === 'STAR' || t === 'POLYGON' || t === 'ELLIPSE' || t === 'RECTANGLE')) {
    if (t === 'VECTOR') {
      try { if (node.vectorPaths && node.vectorPaths.length) o.vectorPaths = trClone(node.vectorPaths); } catch (e) {}
    }
  }
  if (t === 'TEXT') {
    o.characters = node.characters;
    ['textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'paragraphSpacing', 'paragraphIndent', 'leadingTrim'].forEach(function (k) {
      try { var v = node[k]; if (v !== undefined && !trMixed(v)) o[k] = v; } catch (e) {}
    });
    try {
      var segs = node.getStyledTextSegments(['fontName', 'fontSize', 'textDecoration', 'textCase', 'lineHeight', 'letterSpacing', 'fills', 'textStyleId', 'hyperlink']);
      o.segs = [];
      for (var si = 0; si < segs.length; si++) {
        var sg = segs[si];
        var segObj = { s: sg.start, e: sg.end, fontName: sg.fontName, fontSize: sg.fontSize };
        if (sg.textDecoration && sg.textDecoration !== 'NONE') segObj.textDecoration = sg.textDecoration;
        if (sg.textCase && sg.textCase !== 'ORIGINAL') segObj.textCase = sg.textCase;
        if (sg.lineHeight) segObj.lineHeight = sg.lineHeight;
        if (sg.letterSpacing) segObj.letterSpacing = sg.letterSpacing;
        if (sg.hyperlink) segObj.hyperlink = sg.hyperlink;
        if (sg.fills && sg.fills.length) segObj.fills = await trPaints(sg.fills, ctx);
        if (sg.textStyleId) segObj.styleKey = await trStyleKey(sg.textStyleId, ctx);
        o.segs.push(segObj);
        if (sg.fontName) ctx.fonts[sg.fontName.family + '|' + sg.fontName.style] = sg.fontName;
      }
    } catch (e) { o.segs = []; }
  }
  if (t === 'INSTANCE') {
    try {
      var mc = await node.getMainComponentAsync();
      if (mc) {
        o.mainKey = mc.key;
        o.mainId = mc.id;
        o.mainName = mc.name;
        var par = mc.parent;
        o.mainSet = par && par.type === 'COMPONENT_SET' ? par.name : null;
      }
      var cp = node.componentProperties || {};
      o.props = {};
      Object.keys(cp).forEach(function (k) {
        var d = cp[k];
        if (d && (d.type === 'TEXT' || d.type === 'BOOLEAN')) o.props[k] = d.value;
      });
    } catch (e) {}
  }
  if (t === 'COMPONENT_SET') { try { o.compDefs = null; } catch (e) {} }
  if ('children' in node && t !== 'BOOLEAN_OPERATION' || t === 'BOOLEAN_OPERATION') {
    o.children = [];
    var kids = node.children || [];
    for (var ci = 0; ci < kids.length; ci++) {
      if (trCancelled) throw new Error('Cancelled');
      var ct = kids[ci].type;
      if (ct === 'SLICE' || ct === 'STICKY' || ct === 'SHAPE_WITH_TEXT' || ct === 'CONNECTOR' || ct === 'CODE_BLOCK' || ct === 'STAMP' || ct === 'WIDGET' || ct === 'EMBED' || ct === 'LINK_UNFURL' || ct === 'MEDIA' || ct === 'HIGHLIGHT' || ct === 'WASHI_TAPE' || ct === 'TABLE') {
        ctx.skipped++;
        continue;
      }
      var childRes = await trSer(kids[ci], ctx, isInsideInstance || t === 'INSTANCE');
      if (childRes) o.children.push(childRes);
    }
  }
  return o;
}

async function trExport(msg) {
  trCancelled = false;
  var exportedImages = {}; // Deduplicate images across the entire export run
  var ids = msg.pageIds || [];
  for (var i = 0; i < ids.length; i++) {
    if (trCancelled) {
      figma.ui.postMessage({ type: 'TR_EXPORT_DONE', jobId: msg.jobId, cancelled: true });
      return;
    }
    var page = await figma.getNodeByIdAsync(ids[i]);
    if (!page || page.type !== 'PAGE') {
      figma.ui.postMessage({ type: 'TR_EXPORT_ERROR', jobId: msg.jobId, index: i, error: 'Page not found' });
      return;
    }
    figma.ui.postMessage({ type: 'TR_PROGRESS', jobId: msg.jobId, phase: 'export', index: i, name: page.name, total: ids.length });
    try {
      await page.loadAsync();
      
      // 1. Gather all valid top-level nodes on this page
      var topChildren = [];
      for (var k = 0; k < page.children.length; k++) {
        var ct = page.children[k].type;
        if (ct === 'SLICE' || ct === 'STICKY' || ct === 'CONNECTOR' || ct === 'SHAPE_WITH_TEXT' || ct === 'CODE_BLOCK' || ct === 'WIDGET' || ct === 'EMBED' || ct === 'TABLE') continue;
        topChildren.push(page.children[k]);
      }
      
      // 2. Memory-Safe Streaming Chunks:
      // In Figma's 32-bit WebAssembly environment, allocating hundreds of megabytes causes
      // instant OOM crashes ("Reason: crashed").
      // To guarantee rock-solid stability and zero memory bloat:
      // - Every top-level frame/component/section/group is streamed in its OWN chunk.
      // - Small loose shapes (rectangles, text, etc.) are batched up to 10 per chunk.
      var chunks = [];
      var curChunk = [];
      for (var ti = 0; ti < topChildren.length; ti++) {
        var tnode = topChildren[ti];
        var isContainer = tnode.type === 'FRAME' || tnode.type === 'SECTION' || tnode.type === 'GROUP' || tnode.type === 'COMPONENT' || tnode.type === 'COMPONENT_SET';
        if (isContainer) {
          if (curChunk.length > 0) {
            chunks.push(curChunk);
            curChunk = [];
          }
          chunks.push([tnode]);
        } else {
          curChunk.push(tnode);
          if (curChunk.length >= 10) {
            chunks.push(curChunk);
            curChunk = [];
          }
        }
      }
      if (curChunk.length > 0) chunks.push(curChunk);
      
      var bg = null;
      try { if (page.backgrounds && page.backgrounds.length) bg = trClone(page.backgrounds); } catch (e) {}
      
      // 3. Send page start manifest
      await new Promise(function (resolve) {
        var timer = setTimeout(function () { if (trAckResolve) { trAckResolve = null; resolve(); } }, 10000);
        trAckResolve = function () { clearTimeout(timer); trAckResolve = null; resolve(); };
        figma.ui.postMessage({
          type: 'TR_PAGE_START',
          jobId: msg.jobId,
          pageIndex: i,
          name: page.name,
          backgrounds: bg,
          totalChunks: chunks.length,
          totalItems: topChildren.length
        });
      });
      
      // 4. Stream each chunk one by one
      for (var c = 0; c < chunks.length; c++) {
        if (trCancelled) throw new Error('Cancelled');
        
        // Fault-tolerance resume: skip chunk if already saved on server
        if (msg.resumeChunks && msg.resumeChunks[i + '_' + c]) {
          continue;
        }

        var chunkNodesToSer = chunks[c];
        var chunkCtx = { count: 0, skipped: 0, images: {}, fonts: {}, varKeys: trGlobalVarCache, styleKeys: trGlobalStyleCache };
        var serializedNodes = [];
        for (var ni = 0; ni < chunkNodesToSer.length; ni++) {
          if (trCancelled) throw new Error('Cancelled');
          var sn = await trSer(chunkNodesToSer[ni], chunkCtx, false);
          if (sn) serializedNodes.push(sn);
        }
        
        // Stream images used in this chunk first (deduplicating already uploaded images)
        var chunkHashes = Object.keys(chunkCtx.images);
        for (var ch = 0; ch < chunkHashes.length; ch++) {
          if (trCancelled) throw new Error('Cancelled');
          var hash = chunkHashes[ch];
          if (exportedImages[hash]) continue;
          try {
            var im = figma.getImageByHash(hash);
            if (im) {
              var bytes = null;
              try {
                bytes = await withTimeout(im.getBytesAsync(), 7000, 'im.getBytesAsync(' + hash + ')');
              } catch (eTime) {
                console.warn('Timed out reading image ' + hash + ', skipping image bytes…');
              }
              if (bytes) {
                exportedImages[hash] = true;
                await new Promise(function (resolve) {
                  var timer = setTimeout(function () {
                    if (trImageAckResolve) {
                      trImageAckResolve = null;
                      console.warn('TR_IMAGE_CHUNK ack timeout for ' + hash + ', advancing…');
                      resolve();
                    }
                  }, 10000);
                  trImageAckResolve = function () {
                    clearTimeout(timer);
                    trImageAckResolve = null;
                    resolve();
                  };
                  figma.ui.postMessage({
                    type: 'TR_IMAGE_CHUNK',
                    jobId: msg.jobId,
                    hash: hash,
                    bytes: bytes
                  });
                });
                bytes = null;
              }
            }
          } catch (eImg) {}
          await trYield();
        }
        
        var chunkFonts = Object.keys(chunkCtx.fonts).map(function (k) { return chunkCtx.fonts[k]; });
        var chkLabel = chunkNodesToSer.length === 1
          ? (chunkNodesToSer[0] ? chunkNodesToSer[0].name : '')
          : (chunkNodesToSer.length + ' items (' + (chunkNodesToSer[0] ? chunkNodesToSer[0].name : '') + '…)');
        var chunkPayload = JSON.stringify({
          pageIndex: i,
          chunkIndex: c,
          totalChunks: chunks.length,
          name: chkLabel,
          fonts: chunkFonts,
          nodes: serializedNodes
        });
        
        // Free memory immediately
        serializedNodes = null;
        chunkCtx = null;
        
        await new Promise(function (resolve) {
          var timer = setTimeout(function () {
            if (trAckResolve) {
              trAckResolve = null;
              console.warn('TR_CHUNK_DATA ack timeout for chunk ' + c + ', advancing…');
              resolve();
            }
          }, 15000);
          trAckResolve = function () {
            clearTimeout(timer);
            trAckResolve = null;
            resolve();
          };
          figma.ui.postMessage({
            type: 'TR_CHUNK_DATA',
            jobId: msg.jobId,
            pageIndex: i,
            chunkIndex: c,
            totalChunks: chunks.length,
            name: chkLabel,
            json: chunkPayload
          });
        });
        chunkPayload = null;
        
        await new Promise(function (r) { setTimeout(r, 0); });
      }
      
      // 5. Send page end
      await new Promise(function (resolve) {
        var timer = setTimeout(function () { if (trAckResolve) { trAckResolve = null; resolve(); } }, 10000);
        trAckResolve = function () { clearTimeout(timer); trAckResolve = null; resolve(); };
        figma.ui.postMessage({
          type: 'TR_PAGE_END',
          jobId: msg.jobId,
          pageIndex: i,
          name: page.name,
          totalChunks: chunks.length
        });
      });
      
      topChildren = null;
      chunks = null;
      page = null;
      await new Promise(function (r) { setTimeout(r, 50); });
      
    } catch (e) {
      if (trCancelled || String(e && e.message || e).indexOf('Cancelled') >= 0) {
        figma.ui.postMessage({ type: 'TR_EXPORT_DONE', jobId: msg.jobId, cancelled: true });
        return;
      }
      figma.ui.postMessage({ type: 'TR_EXPORT_ERROR', jobId: msg.jobId, index: i, error: String(e && e.message || e) });
      return;
    }
  }
  figma.ui.postMessage({ type: 'TR_EXPORT_DONE', jobId: msg.jobId });
}

async function trRegisterImage(msg) {
  try {
    if (msg.hash && msg.bytes && !trImageMap[msg.hash]) {
      var im = figma.createImage(msg.bytes);
      if (im) trImageMap[msg.hash] = im.hash;
    }
    figma.ui.postMessage({ type: 'TR_REGISTER_IMAGE_ACK', hash: msg.hash });
  } catch (e) {
    figma.ui.postMessage({ type: 'TR_REGISTER_IMAGE_ACK', hash: msg.hash, error: String(e && e.message || e) });
  }
}

// ---------- builder (destination file) ----------
async function trLoadFont(fn) {
  try { await figma.loadFontAsync(fn); return fn; } catch (e) {}
  try { await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }); return { family: 'Inter', style: 'Regular' }; } catch (e2) { return null; }
}
async function trImportVar(key, ctx) {
  if (!key) return null;
  if (ctx.vars[key] !== undefined) return ctx.vars[key];
  var v = null; try { v = await figma.variables.importVariableByKeyAsync(key); } catch (e) { ctx.stats.varMiss++; }
  ctx.vars[key] = v; return v;
}
async function trImportStyle(key, ctx) {
  if (!key) return null;
  if (ctx.styles[key] !== undefined) return ctx.styles[key];
  var s = null; try { s = await figma.importStyleByKeyAsync(key); } catch (e) { ctx.stats.styleMiss++; }
  ctx.styles[key] = s; return s;
}
async function trBuildPaints(arr, ctx) {
  if (!arr) return null;
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var p = arr[i], q;
    if (p.type === 'SOLID') {
      q = { type: 'SOLID', color: p.color, opacity: p.opacity, visible: p.visible, blendMode: p.blendMode };
      if (p.bvColor) { var v = await trImportVar(p.bvColor, ctx); if (v) { try { q = figma.variables.setBoundVariableForPaint(q, 'color', v); } catch (e) {} } }
    } else if (p.type.indexOf('GRADIENT') === 0) {
      q = { type: p.type, gradientStops: p.gradientStops, gradientTransform: p.gradientTransform, opacity: p.opacity, visible: p.visible, blendMode: p.blendMode };
    } else if (p.type === 'IMAGE') {
      var nh = trImageMap[p.imageHash];
      if (!nh) { ctx.stats.imgMiss++; continue; }
      q = { type: 'IMAGE', imageHash: nh, scaleMode: p.scaleMode, opacity: p.opacity, visible: p.visible, blendMode: p.blendMode };
      if (p.scaleMode === 'CROP' && p.imageTransform) q.imageTransform = p.imageTransform;
      if (p.scaleMode === 'TILE') { q.scalingFactor = p.scalingFactor; q.rotation = p.rotation; }
      if (p.filters) q.filters = p.filters;
    } else continue;
    out.push(q);
  }
  return out;
}
function trSet(node, k, v) { if (v === undefined || v === null) return; try { node[k] = v; } catch (e) {} }
async function trApplyCommon(node, sn, ctx, isTop) {
  trSet(node, 'name', sn.name);
  try { if (sn.w > 0 && sn.h > 0 && 'resize' in node && sn.type !== 'TEXT') node.resize(Math.max(0.01, sn.w), Math.max(0.01, sn.h)); } catch (e) {}
  ['visible', 'locked', 'opacity', 'blendMode', 'isMask', 'maskType', 'constraints'].forEach(function (k) { trSet(node, k, sn[k]); });
  if ('fills' in node && sn.fills) { var f = await trBuildPaints(sn.fills, ctx); if (f) trSet(node, 'fills', f); }
  if ('strokes' in node && sn.strokes) { var s = await trBuildPaints(sn.strokes, ctx); if (s) trSet(node, 'strokes', s); }
  ['strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight',
    'cornerSmoothing', 'clipsContent', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].forEach(function (k) { if (k in node) trSet(node, k, sn[k]); });
  if (sn.effects && 'effects' in node) trSet(node, 'effects', sn.effects);
  if (sn.layoutGrids && 'layoutGrids' in node) trSet(node, 'layoutGrids', sn.layoutGrids);
  if (sn.layoutMode && sn.layoutMode !== 'NONE' && 'layoutMode' in node && sn.layoutMode !== 'GRID') {
    trSet(node, 'layoutMode', sn.layoutMode);
    ['layoutWrap', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'itemSpacing', 'counterAxisSpacing', 'itemReverseZIndex', 'strokesIncludedInLayout'].forEach(function (k) { trSet(node, k, sn[k]); });
  }
  ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(function (k) { if (k in node) trSet(node, k, sn[k]); });
  // styles
  try {
    if (sn.fillStyleKey && 'setFillStyleIdAsync' in node) { var fs = await trImportStyle(sn.fillStyleKey, ctx); if (fs) await node.setFillStyleIdAsync(fs.id); }
    if (sn.strokeStyleKey && 'setStrokeStyleIdAsync' in node) { var ss = await trImportStyle(sn.strokeStyleKey, ctx); if (ss) await node.setStrokeStyleIdAsync(ss.id); }
    if (sn.effectStyleKey && 'setEffectStyleIdAsync' in node) { var es = await trImportStyle(sn.effectStyleKey, ctx); if (es) await node.setEffectStyleIdAsync(es.id); }
    if (sn.gridStyleKey && 'setGridStyleIdAsync' in node) { var gs = await trImportStyle(sn.gridStyleKey, ctx); if (gs) await node.setGridStyleIdAsync(gs.id); }
  } catch (e) {}
  // variables
  if (sn.bv) {
    var keys = Object.keys(sn.bv);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] === 'characters' || keys[i] === 'width' || keys[i] === 'height') continue;
      var vv = await trImportVar(sn.bv[keys[i]], ctx);
      if (vv) { try { node.setBoundVariable(keys[i], vv); } catch (e) {} }
    }
  }
}
async function trApplyText(node, sn, ctx) {
  var first = (sn.segs && sn.segs[0] && sn.segs[0].fontName) || { family: 'Inter', style: 'Regular' };
  var ok = await trLoadFont(first);
  if (ok) node.fontName = ok;
  var fonts = {}; (sn.segs || []).forEach(function (g) { fonts[g.fontName.family + '|' + g.fontName.style] = g.fontName; });
  var fk = Object.keys(fonts); for (var i = 0; i < fk.length; i++) await trLoadFont(fonts[fk[i]]);
  node.characters = sn.characters || '';
  ['textAlignHorizontal', 'textAlignVertical', 'paragraphSpacing', 'paragraphIndent'].forEach(function (k) { trSet(node, k, sn[k]); });
  var segs = sn.segs || [];
  for (var j = 0; j < segs.length; j++) {
    var g = segs[j], s = g.s, e = g.e;
    if (e <= s) continue;
    try { node.setRangeFontName(s, e, (await trLoadFont(g.fontName)) || g.fontName); } catch (x) {}
    try { node.setRangeFontSize(s, e, g.fontSize); } catch (x) {}
    try { node.setRangeTextDecoration(s, e, g.textDecoration); } catch (x) {}
    try { node.setRangeTextCase(s, e, g.textCase); } catch (x) {}
    try { node.setRangeLineHeight(s, e, g.lineHeight); } catch (x) {}
    try { node.setRangeLetterSpacing(s, e, g.letterSpacing); } catch (x) {}
    try { var pf = await trBuildPaints(g.fills, ctx); if (pf) node.setRangeFills(s, e, pf); } catch (x) {}
    try { if (g.hyperlink) node.setRangeHyperlink(s, e, g.hyperlink); } catch (x) {}
    try { if (g.styleKey) { var st = await trImportStyle(g.styleKey, ctx); if (st) await node.setRangeTextStyleIdAsync(s, e, st.id); } } catch (x) {}
  }
  trSet(node, 'textAutoResize', sn.textAutoResize);
  if (sn.textAutoResize === 'NONE' || sn.textAutoResize === 'TRUNCATE' || sn.textAutoResize === 'HEIGHT') { try { node.resize(Math.max(0.01, sn.w), Math.max(0.01, sn.h)); } catch (e) {} }
}
function trPlaceXY(node, sn, parent) {
  try {
    var autoParent = parent && 'layoutMode' in parent && parent.layoutMode && parent.layoutMode !== 'NONE';
    if (autoParent && sn.layoutPositioning !== 'ABSOLUTE') return;
    if (sn.t) node.relativeTransform = sn.t;
  } catch (e) {}
}
function trApplySizing(node, sn, parent) {
  try {
    var autoParent = parent && 'layoutMode' in parent && parent.layoutMode && parent.layoutMode !== 'NONE';
    if (autoParent && sn.layoutPositioning === 'ABSOLUTE') { try { node.layoutPositioning = 'ABSOLUTE'; } catch (e) {} }
    if (sn.layoutSizingHorizontal) { try { node.layoutSizingHorizontal = sn.layoutSizingHorizontal; } catch (e) {} }
    if (sn.layoutSizingVertical) { try { node.layoutSizingVertical = sn.layoutSizingVertical; } catch (e) {} }
    if (sn.layoutMode && sn.layoutMode !== 'NONE' && 'primaryAxisSizingMode' in node) {
      if (sn.primaryAxisSizingMode) trSet(node, 'primaryAxisSizingMode', sn.primaryAxisSizingMode);
      if (sn.counterAxisSizingMode) trSet(node, 'counterAxisSizingMode', sn.counterAxisSizingMode);
    }
  } catch (e) {}
}
async function trGetLib(key, ctx) {
  if (trLibCache[key] !== undefined) return trLibCache[key];
  var c = null; try { c = await figma.importComponentByKeyAsync(key); } catch (e) {}
  trLibCache[key] = c; return c;
}
function trSameJson(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; } }
async function trOverrides(inst, sn, ctx) {
  // Re-apply what was changed inside the instance (text, fills, visibility...) by walking both trees in parallel.
  var pc = 'children' in inst ? inst.children : [], sc = sn.children || [];
  for (var i = 0; i < sc.length && i < pc.length; i++) {
    var a = pc[i], b = sc[i];
    if (a.type !== b.type) continue;
    try {
      if (b.type === 'INSTANCE' && b.mainKey) {
        var cur = await a.getMainComponentAsync();
        if (!cur || cur.key !== b.mainKey) { var lc = await trGetLib(b.mainKey, ctx); if (lc) a.swapComponent(lc); }
        if (b.props) { try { var pp = {}; Object.keys(b.props).forEach(function (k) { if (a.componentProperties && a.componentProperties[k]) pp[k] = b.props[k]; }); a.setProperties(pp); } catch (e) {} }
      }
      if (a.visible !== b.visible && b.visible !== undefined) a.visible = b.visible;
      if (b.opacity !== undefined && Math.abs(a.opacity - b.opacity) > 0.001) a.opacity = b.opacity;
      if (b.type === 'TEXT') {
        if (a.characters !== b.characters) await trApplyText(a, b, ctx);
        else if (b.segs && b.segs.length === 1 && b.segs[0].fills) { var tf = await trBuildPaints(b.segs[0].fills, ctx); if (tf && !trSameJson(tf, a.fills)) a.fills = tf; }
      } else if ('fills' in a && b.fills && !b.fillStyleKey) {
        var nf = await trBuildPaints(b.fills, ctx);
        if (nf && !trSameJson(nf, a.fills)) a.fills = nf;
      }
      if (b.type !== 'TEXT' && 'resize' in a && b.w > 0 && (Math.abs(a.width - b.w) > 0.5 || Math.abs(a.height - b.h) > 0.5) && !(inst.layoutMode && inst.layoutMode !== 'NONE')) { try { a.resize(b.w, b.h); } catch (e) {} }
    } catch (e) { /* keep going: one bad override must not stop the page */ }
    if (b.children && b.children.length && 'children' in a) await trOverrides(a, b, ctx);
  }
}
async function trBuild(sn, parent, ctx) {
  ctx.done++;
  if (ctx.done % 100 === 0) { figma.ui.postMessage({ type: 'TR_PROGRESS', jobId: ctx.jobId, phase: 'build', index: ctx.index, name: ctx.name, done: ctx.done, total: ctx.total }); await trYield(); }
  if (trCancelled) throw new Error('Cancelled');
  var t = sn.type, node = null, asFrame = false;
  if (t === 'INSTANCE') {
    var comp = null;
    if (ctx.local[sn.mainId]) comp = ctx.local[sn.mainId];
    else if (sn.mainKey) comp = await trGetLib(sn.mainKey, ctx);
    if (comp) {
      node = comp.createInstance(); parent.appendChild(node); ctx.stats.linked++;
      await trApplyCommon(node, sn, ctx, false);
      if (sn.props) { try { var pp = {}; Object.keys(sn.props).forEach(function (k) { if (node.componentProperties && node.componentProperties[k]) pp[k] = sn.props[k]; }); node.setProperties(pp); } catch (e) {} }
      await trOverrides(node, sn, ctx);
      trApplySizing(node, sn, parent); trPlaceXY(node, sn, parent);
      return node;
    }
    ctx.stats.detached++; asFrame = true; t = 'FRAME';
  }
  if (t === 'FRAME' || asFrame) node = figma.createFrame();
  else if (t === 'GROUP') node = null;
  else if (t === 'SECTION') node = figma.createSection();
  else if (t === 'COMPONENT') node = figma.createComponent();
  else if (t === 'COMPONENT_SET') node = null;
  else if (t === 'RECTANGLE') node = figma.createRectangle();
  else if (t === 'ELLIPSE') node = figma.createEllipse();
  else if (t === 'POLYGON') node = figma.createPolygon();
  else if (t === 'STAR') node = figma.createStar();
  else if (t === 'LINE') node = figma.createLine();
  else if (t === 'VECTOR') node = figma.createVector();
  else if (t === 'TEXT') node = figma.createText();
  else if (t === 'BOOLEAN_OPERATION') node = null;
  else { ctx.stats.skipped++; return null; }

  if (t === 'GROUP' || t === 'BOOLEAN_OPERATION' || t === 'COMPONENT_SET') {
    // containers made from their children
    var made = [];
    for (var i = 0; i < (sn.children || []).length; i++) { var c = await trBuild(sn.children[i], parent, ctx); if (c) made.push(c); }
    if (!made.length) return null;
    var cont;
    try {
      if (t === 'GROUP') cont = figma.group(made, parent);
      else if (t === 'BOOLEAN_OPERATION') { cont = figma.createBooleanOperation(); parent.appendChild(cont); made.forEach(function (m) { cont.appendChild(m); }); cont.booleanOperation = sn.booleanOperation || 'UNION'; }
      else { var comps = made.filter(function (m) { return m.type === 'COMPONENT'; }); cont = comps.length ? figma.combineAsVariants(comps, parent) : null; }
    } catch (e) { cont = null; }
    if (cont) { trSet(cont, 'name', sn.name); await trApplyCommon(cont, sn, ctx, false); trApplySizing(cont, sn, parent); }
    return cont;
  }
  parent.appendChild(node);
  if (t === 'COMPONENT') ctx.local[sn.id] = node;
  await trApplyCommon(node, sn, ctx, false);
  if (t === 'VECTOR' && sn.vectorPaths) { try { node.vectorPaths = sn.vectorPaths; } catch (e) {} }
  if (t === 'STAR') { trSet(node, 'pointCount', sn.pointCount); trSet(node, 'innerRadius', sn.innerRadius); }
  if (t === 'POLYGON') trSet(node, 'pointCount', sn.pointCount);
  if (t === 'ELLIPSE') trSet(node, 'arcData', sn.arcData);
  if (t === 'TEXT') await trApplyText(node, sn, ctx);
  if (sn.children && 'appendChild' in node) {
    for (var j = 0; j < sn.children.length; j++) await trBuild(sn.children[j], node, ctx);
  }
  trApplySizing(node, sn, parent); trPlaceXY(node, sn, parent);
  return node;
}

var trCurrentImportPage = null;
var trImportCtx = null;

async function trBuildPageStart(msg) {
  var name = msg.name;
  var exists = figma.root.children.some(function (p) { return p.name === name; });
  if (exists) name = name + ' (transferred)';
  trCurrentImportPage = figma.createPage();
  trCurrentImportPage.name = name;
  if (msg.backgrounds) { try { trCurrentImportPage.backgrounds = msg.backgrounds; } catch (e) {} }
  trImportCtx = {
    jobId: msg.jobId,
    index: msg.pageIndex,
    name: name,
    done: 0,
    vars: {},
    styles: {},
    local: {},
    stats: { linked: 0, detached: 0, skipped: 0, varMiss: 0, styleMiss: 0, imgMiss: 0 }
  };
  figma.ui.postMessage({ type: 'TR_BUILD_PAGE_START_ACK', pageIndex: msg.pageIndex, pageName: name });
}

async function trBuildChunk(msg) {
  if (trCancelled) {
    figma.ui.postMessage({ type: 'TR_BUILD_CHUNK_ACK', pageIndex: msg.pageIndex, chunkIndex: msg.chunkIndex, cancelled: true });
    return;
  }
  var data = JSON.parse(msg.json);
  var fonts = data.fonts || [];
  for (var f = 0; f < fonts.length; f++) await trLoadFont(fonts[f]);
  
  if (!trCurrentImportPage) {
    var pName = (msg.pageName || 'Page') + ' (transferred)';
    trCurrentImportPage = figma.createPage();
    trCurrentImportPage.name = pName;
  }
  if (!trImportCtx) {
    trImportCtx = {
      jobId: msg.jobId,
      index: msg.pageIndex,
      name: trCurrentImportPage.name,
      done: 0,
      vars: {},
      styles: {},
      local: {},
      stats: { linked: 0, detached: 0, skipped: 0, varMiss: 0, styleMiss: 0, imgMiss: 0 }
    };
  }
  
  var nodes = data.nodes || [];
  for (var i = 0; i < nodes.length; i++) {
    if (trCancelled) throw new Error('Cancelled');
    await trBuild(nodes[i], trCurrentImportPage, trImportCtx);
  }
  nodes = null;
  data = null;
  
  figma.ui.postMessage({
    type: 'TR_BUILD_CHUNK_ACK',
    pageIndex: msg.pageIndex,
    chunkIndex: msg.chunkIndex,
    totalChunks: msg.totalChunks,
    stats: trImportCtx ? trImportCtx.stats : {}
  });
}

async function trBuildPageEnd(msg) {
  var st = trImportCtx ? trImportCtx.stats : {};
  var pName = trCurrentImportPage ? trCurrentImportPage.name : msg.name;
  trCurrentImportPage = null;
  trImportCtx = null;
  figma.ui.postMessage({
    type: 'TR_BUILD_PAGE_END_ACK',
    pageIndex: msg.pageIndex,
    ok: true,
    pageName: pName,
    stats: st
  });
}

async function trImportPage(msg) {
  trCancelled = false;
  var data = JSON.parse(msg.json);
  // images -> this file
  var im = msg.images || {};
  Object.keys(im).forEach(function (h) { if (!trImageMap[h]) { try { trImageMap[h] = figma.createImage(im[h]).hash; } catch (e) {} } });
  var fonts = data.fonts || []; for (var f = 0; f < fonts.length; f++) await trLoadFont(fonts[f]);
  var name = data.name, exists = figma.root.children.some(function (p) { return p.name === name; });
  if (exists) name = name + ' (transferred)';
  var page = figma.createPage(); page.name = name;
  var ctx = { jobId: msg.jobId, index: msg.index, name: data.name, done: 0, total: data.nodeCount || 1, vars: {}, styles: {}, local: {}, stats: { linked: 0, detached: 0, skipped: data.skipped || 0, varMiss: 0, styleMiss: 0, imgMiss: 0 } };
  try {
    if (data.backgrounds) { try { page.backgrounds = data.backgrounds; } catch (e) {} }
    for (var i = 0; i < (data.children || []).length; i++) await trBuild(data.children[i], page, ctx);
    figma.ui.postMessage({ type: 'TR_IMPORT_RESULT', jobId: msg.jobId, index: msg.index, ok: true, pageName: name, stats: ctx.stats });
  } catch (e) {
    try { page.remove(); } catch (x) {}
    figma.ui.postMessage({ type: 'TR_IMPORT_RESULT', jobId: msg.jobId, index: msg.index, ok: false, error: String(e && e.message || e) });
  }
}

// ---------- archive (source file) ----------
async function trArchive(msg) {
  var arch = null;
  figma.root.children.forEach(function (p) { if (!arch && /archive/i.test(p.name)) arch = p; });
  if (!arch) { arch = figma.createPage(); arch.name = 'Archive'; }
  await arch.loadAsync();
  var y = 0;
  arch.children.forEach(function (c) { y = Math.max(y, c.y + c.height); });
  y += y ? 600 : 0;
  var moved = 0, pages = 0, fontOk = await trLoadFont({ family: 'Inter', style: 'Bold' });
  for (var i = 0; i < (msg.pageIds || []).length; i++) {
    var p = await figma.getNodeByIdAsync(msg.pageIds[i]);
    if (!p || p.type !== 'PAGE' || p.id === arch.id) continue;
    await p.loadAsync();
    var kids = p.children.slice();
    if (!kids.length) continue;
    var minX = Infinity, minY = Infinity, maxY = -Infinity;
    kids.forEach(function (k) { minX = Math.min(minX, k.x); minY = Math.min(minY, k.y); maxY = Math.max(maxY, k.y + k.height); });
    if (fontOk) { var lb = figma.createText(); arch.appendChild(lb); lb.fontName = fontOk; lb.fontSize = 48; lb.characters = p.name + ' — transferred ' + new Date().toISOString().slice(0, 10); lb.x = 0; lb.y = y; }
    var dx = -minX, dy = y + 120 - minY;
    kids.forEach(function (k) { arch.appendChild(k); k.x += dx; k.y += dy; moved++; });
    y += (maxY - minY) + 120 + 600; pages++;
    if (msg.deleteAfterArchive) {
      try { p.remove(); } catch (e) {}
    }
    await trYield();
  }
  var l_arch = await trListPages();
  figma.ui.postMessage({ type: 'TR_ARCHIVE_RESULT', ok: true, moved: moved, pages: pages, archiveName: arch.name, newPages: l_arch.pages });
}

// ---------- native copy/paste helpers ----------
async function trNativeSelect(msg) {
  var p = await figma.getNodeByIdAsync(msg.pageId);
  if (!p || p.type !== 'PAGE') { figma.ui.postMessage({ type: 'TR_NATIVE_RESULT', ok: false, error: 'Page not found' }); return; }
  if (figma.currentPage !== p) await figma.setCurrentPageAsync(p);
  // Skip the agents feature's temporary cursor overlay; it is not part of the design.
  var items = p.children.filter(function (n) { return n.name !== GHOST_CONTAINER_NAME; });
  // msg.clear: deselect, so the focus click cannot land on a selected frame's handles.
  p.selection = msg.clear ? [] : items;
  if (!msg.keepView) { try { if (items.length) figma.viewport.scrollAndZoomIntoView(items); } catch (e) {} }
  figma.ui.postMessage({ type: 'TR_NATIVE_RESULT', ok: true, count: items.length, name: p.name, bounds: trNodesBounds(items) });
}

// Bounding box (page coordinates) of a list of top-level nodes.
function trNodesBounds(nodes) {
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]; if (typeof n.x !== 'number') continue;
    var w = n.width || 0, h = n.height || 0;
    if (n.x < x0) x0 = n.x; if (n.y < y0) y0 = n.y;
    if (n.x + w > x1) x1 = n.x + w; if (n.y + h > y1) y1 = n.y + h;
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

// Automatic paste: open/create the page, remember what is already there, aim the view at the source position.
var trPasteBefore = null, trPastePage = null;
async function trNativePrepare(msg) {
  var page = null;
  figma.root.children.forEach(function (p) { if (!page && p.name === msg.name) page = p; });
  var created = false;
  if (!page) { page = figma.createPage(); page.name = msg.name; created = true; }
  await figma.setCurrentPageAsync(page);
  page.selection = [];
  trPastePage = page; trPasteBefore = {};
  page.children.forEach(function (n) { trPasteBefore[n.id] = 1; });
  var b = msg.bounds;
  if (b) {
    try {
      figma.viewport.center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      var vb = figma.viewport.bounds, z = figma.viewport.zoom;
      var fit = Math.min((vb.width * z) / b.w, (vb.height * z) / b.h) * 0.9;
      figma.viewport.zoom = Math.max(0.02, Math.min(4, fit));
    } catch (e) {}
  }
  figma.ui.postMessage({ type: 'TR_NATIVE_PREPARED', ok: true, name: page.name, created: created, existing: page.children.length });
}
function trPastedNodes() {
  if (!trPastePage || !trPasteBefore) return [];
  return trPastePage.children.filter(function (n) { return !trPasteBefore[n.id] && n.name !== GHOST_CONTAINER_NAME; });
}
function trNativeCount() {
  figma.ui.postMessage({ type: 'TR_NATIVE_COUNTED', count: trPastedNodes().length });
}
// Put the pasted items back at their original position (Figma may drop them at the view centre).
function trNativeFinish(msg) {
  var nodes = trPastedNodes(), moved = false, b = msg.bounds, nb = trNodesBounds(nodes);
  if (b && nb) {
    var dx = b.x - nb.x, dy = b.y - nb.y;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      nodes.forEach(function (n) { try { n.x += dx; n.y += dy; } catch (e) {} });
      moved = true;
    }
  }
  try { if (nodes.length) figma.viewport.scrollAndZoomIntoView(nodes); } catch (e) {}
  if (trPastePage) trPastePage.selection = [];
  figma.ui.postMessage({ type: 'TR_NATIVE_FINISHED', count: nodes.length, moved: moved });
  trPasteBefore = null; trPastePage = null;
}
async function trNativeOpen(msg) {
  var page = null;
  figma.root.children.forEach(function (p) { if (!page && p.name === msg.name) page = p; });
  var created = false;
  if (!page) { page = figma.createPage(); page.name = msg.name; created = true; }
  await figma.setCurrentPageAsync(page);
  figma.ui.postMessage({ type: 'TR_NATIVE_OPENED', ok: true, name: msg.name, created: created, empty: page.children.length === 0 });
}


// ---------- delete pages (source file) ----------
async function trDeletePages(msg) {
  var ids = msg.pageIds || [];
  var deleted = 0;
  var names = [];
  var remaining = figma.root.children.filter(function (p) {
    return ids.indexOf(p.id) < 0;
  });
  if (remaining.length === 0) {
    var fallback = figma.createPage();
    fallback.name = 'Page 1';
  }
  for (var i = 0; i < ids.length; i++) {
    var p = await figma.getNodeByIdAsync(ids[i]);
    if (p && p.type === 'PAGE') {
      try {
        names.push(p.name);
        p.remove();
        deleted++;
      } catch (e) {
        console.warn('Could not remove page', p.name, e);
      }
    }
  }
  var l = await trListPages();
  figma.ui.postMessage({ type: 'TR_DELETE_RESULT', ok: true, deleted: deleted, names: names, pages: l.pages });
}

async function trHandle(msg) {
  try {
    if (msg.type === 'TR_LIST') {
      var l = await trListPages();
      figma.ui.postMessage({ type: 'TR_LIST_RESULT', fileKey: figma.fileKey || null, fileName: figma.root.name, pages: l.pages, words: l.words, current: figma.currentPage.id });
    } else if (msg.type === 'TR_EXPORT') await trExport(msg);
    else if (msg.type === 'TR_ACK') { if (trAckResolve) { var r = trAckResolve; trAckResolve = null; r(); } }
    else if (msg.type === 'TR_IMAGE_ACK') { if (trImageAckResolve) { var r_img = trImageAckResolve; trImageAckResolve = null; r_img(); } }
    else if (msg.type === 'TR_REGISTER_IMAGE') await trRegisterImage(msg);
    else if (msg.type === 'TR_CANCEL') {
      trCancelled = true;
      if (trAckResolve) { var r2 = trAckResolve; trAckResolve = null; r2(); }
      if (trImageAckResolve) { var r3 = trImageAckResolve; trImageAckResolve = null; r3(); }
      if (trCurrentImportPage && trCurrentImportPage.children.length === 0) {
        try { trCurrentImportPage.remove(); } catch (e) {}
      }
      trCurrentImportPage = null;
      trImportCtx = null;
    }
    else if (msg.type === 'TR_BUILD_PAGE_START') await trBuildPageStart(msg);
    else if (msg.type === 'TR_BUILD_CHUNK') await trBuildChunk(msg);
    else if (msg.type === 'TR_BUILD_PAGE_END') await trBuildPageEnd(msg);
    else if (msg.type === 'TR_IMPORT_PAGE') await trImportPage(msg);
    else if (msg.type === 'TR_ARCHIVE') await trArchive(msg);
    else if (msg.type === 'TR_DELETE_PAGES') await trDeletePages(msg);
    else if (msg.type === 'TR_NATIVE_SELECT') await trNativeSelect(msg);
    else if (msg.type === 'TR_NATIVE_OPEN') await trNativeOpen(msg);
    else if (msg.type === 'TR_NATIVE_PREPARE') await trNativePrepare(msg);
    else if (msg.type === 'TR_NATIVE_COUNT') trNativeCount();
    else if (msg.type === 'TR_NATIVE_FINISH') trNativeFinish(msg);
    else if (msg.type === 'TR_NATIVE_UI') { if (msg.visible) figma.ui.show(); else figma.ui.hide(); }
    else if (msg.type === 'TR_RESET') {
      trImageMap = {};
      trLibCache = {};
      trGlobalVarCache = {};
      trGlobalStyleCache = {};
      trCancelled = false;
      trAckResolve = null;
      trImageAckResolve = null;
      trCurrentImportPage = null;
      trImportCtx = null;
    }
    else if (msg.type === 'TR_NOTIFY') { figma.notify(String(msg.text || ''), { timeout: msg.timeout || 6000, error: !!msg.error }); }
  } catch (e) {
    figma.ui.postMessage({ type: 'TR_FATAL', error: String(e && e.message || e), for: msg.type });
  }
}
