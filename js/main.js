// main.js — browser entry point. AIGameEngine owns loading, lifecycle and simulation time.
// window.app is the ArcApp; its location, camera and game remain available to game code.

function updateLoadingProgress(percent) {
    const bar = /** @type {HTMLElement | null} */ (document.querySelector('.loading-progress'));
    if (bar) bar.style.width = percent + '%';
}

// The loading screen goes away when the location is ready.
function hideLoader() {
    updateLoadingProgress(100);
    setTimeout(() => {
        const screen = document.getElementById('loading-screen');
        if (screen) screen.style.display = 'none';
    }, 300);
}

function showBootError(text) {
    console.error(text);
    const el = document.querySelector('.loading-text');
    if (el) el.textContent = text;
}

function startGame() {
    if (window.app) return window.app;
    if (typeof SimplexNoise === 'undefined') { showBootError('Нет libs/simplex-noise.js'); return; }
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('world3d'));
    updateLoadingProgress(40);
    try {
        const app = window.app = AIGameEngine.boot({ canvas,
            objects: [],
            gameFactory: app => new Game(app),
            cameraInput: false,
            physicsEnabled: false,
            levelId: 'balkonika',
            layout: typeof UI_LAYOUT !== 'undefined' ? UI_LAYOUT : [],
            seed: ArcConfig.get('TERRAIN_NOISE_SEED')
        });
        updateLoadingProgress(70);
        ArcDev.bind(app);
        if (new URLSearchParams(window.location.search).has('arcdev')) ArcDev.mount();
        app.ready.then(ready => { if (ready) hideLoader(); }).catch(error => showBootError(error.message));
        return app;
    } catch (error) { showBootError(error.message || String(error)); }
}

window.onload = () => startGame();
