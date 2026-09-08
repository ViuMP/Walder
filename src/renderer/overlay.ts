/**
 * Walder — overlay renderer. M2a placeholder: proves the bundle loads and the
 * preload bridge is reachable. Sprite animation, expression switching and the
 * speech bubble arrive with the approved art.
 */
const stage = document.getElementById('stage');
if (stage) stage.textContent = 'Walder';

// Bridge smoke check — `window.walder` is an empty frozen object in M2a.
console.log('[walder] bridge keys:', Object.keys(window.walder ?? {}));

export {};
