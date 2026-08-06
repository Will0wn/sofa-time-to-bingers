/**
 * Full page confetti on a throwaway canvas. No dependencies, no library.
 *
 * Two cannons fire inward from the bottom corners, which is what fills the
 * whole viewport rather than leaving a cloud around one button. The canvas is
 * created on demand, sits above everything with pointer events off, and removes
 * itself once the last piece has fallen out of view, so it cannot leak or
 * intercept clicks.
 */

const COLOURS = ['#ffffff', '#f2c14e', '#56c98a', '#5aa9e6', '#e2685c', '#c58af9'];
const GRAVITY = 0.29;
const DRAG = 0.995;

function makeCanvas() {
    const canvas = document.createElement('canvas');
    canvas.style.cssText =
        'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:100';
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    document.body.appendChild(canvas);
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    return { canvas, context };
}

/**
 * @param {number} originX
 * @param {number} originY
 * @param {number} aim     centre angle in radians
 * @param {number} count
 * @param {boolean} gentle fewer, slower, no spin, for reduced-motion users
 */
function cannon(originX, originY, aim, count, gentle) {
    const pieces = [];
    for (let i = 0; i < count; i++) {
        const angle = aim + (Math.random() - 0.5) * 1.15;
        // Muzzle velocity stays the same for everyone: it is what carries the
        // pieces across the viewport, and a slower version would just pile them
        // up in the corners. Reduced motion means fewer pieces and no spinning,
        // not a confetti burst that never leaves the launcher.
        const speed = 31 + Math.random() * 23;
        pieces.push({
            x: originX,
            y: originY,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            width: 5 + Math.random() * 6,
            height: 8 + Math.random() * 7,
            spin: gentle ? 0 : (Math.random() - 0.5) * 0.3,
            angle: Math.random() * Math.PI,
            colour: COLOURS[(Math.random() * COLOURS.length) | 0],
        });
    }
    return pieces;
}

/**
 * Fires the celebration across the whole page.
 * Motion-sensitive users get a smaller, slower, non-spinning version rather
 * than nothing at all.
 */
export function burstConfetti() {
    const gentle = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const count = gentle ? 60 : 110;

    const { canvas, context } = makeCanvas();
    let pieces = [
        // Bottom left, aimed up and to the right.
        ...cannon(-10, height * 0.92, -Math.PI / 3.4, count, gentle),
        // Bottom right, mirrored.
        ...cannon(width + 10, height * 0.92, -Math.PI + Math.PI / 3.4, count, gentle),
    ];

    (function frame() {
        context.clearRect(0, 0, canvas.width, canvas.height);

        for (const piece of pieces) {
            piece.vx *= DRAG;
            piece.vy = piece.vy * DRAG + GRAVITY;
            piece.x += piece.vx;
            piece.y += piece.vy;
            piece.angle += piece.spin;

            context.save();
            context.translate(piece.x, piece.y);
            context.rotate(piece.angle);
            context.fillStyle = piece.colour;
            // Squashing height by the spin fakes a paper flip cheaply.
            context.fillRect(
                -piece.width / 2, -piece.height / 2,
                piece.width, piece.height * Math.abs(Math.cos(piece.angle)),
            );
            context.restore();
        }

        pieces = pieces.filter(piece => piece.y < height + 40);
        if (pieces.length) requestAnimationFrame(frame);
        else canvas.remove();
    })();
}
