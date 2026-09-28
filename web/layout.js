// Places a whole homeland around a single Storage Unit, so the Aniimo hauling each finished batch
// walk as little as they can: a piece's cost is its trips (finished batches) per hour times its
// straight-line distance to the Storage Unit, center to center, and the layout keeps the total low.
//
// A piece is one facility unit, or an environment building with the plots it covers, which moves
// as one rigid block so its coverage stays as planned. Pieces may touch but not overlap, sit on a
// quarter-tile grid (the smallest step in any footprint), and may be turned a quarter at a time.
//
// Busiest pieces for their size go down first, each where it costs least; then each is lifted
// and put back wherever is cheapest with the rest in place, until nothing moves. This is a
// heuristic: it finds a good layout, not a proven best one.

const STEP = 0.25;
const EPSILON = 1e-6;
const CELL = 4;

// `pieces`: `[{ id, members: [{ x, y, w, h, weight, ... }] }]`, members relative to the piece's own
// frame. Returns the pieces with `x`, `y` (the offset applied to their frame) and `turns` (quarter
// turns, applied before the offset), plus the Storage Unit's rectangle. Everything is in tiles.
export function layOut(pieces, storage = { w: 2, h: 2 }) {
    const storageRect = { x: -storage.w / 2, y: -storage.h / 2, w: storage.w, h: storage.h };
    const shapes = pieces.map(piece => orientations(piece.members));
    const weightOf = members => members.reduce((sum, m) => sum + m.weight, 0);
    const areaOf = members => members.reduce((sum, m) => sum + m.w * m.h, 0);
    const order = pieces
        .map((piece, i) => ({ i, density: weightOf(piece.members) / Math.max(areaOf(piece.members), EPSILON) }))
        .sort((a, b) => b.density - a.density || areaOf(pieces[b.i].members) - areaOf(pieces[a.i].members))
        .map(p => p.i);

    const totalArea = pieces.reduce((sum, p) => sum + areaOf(p.members), 0) + storage.w * storage.h;
    const reach = Math.ceil(Math.sqrt(totalArea) * 1.5 + 12);
    const offsets = latticeByDistance(reach);

    const grid = new Map();
    const placedRects = new Map();
    const occupy = (key, rects) => {
        placedRects.set(key, rects);
        rects.forEach(r => cellsOf(r).forEach(c => {
            if (!grid.has(c)) grid.set(c, new Set());
            grid.get(c).add(key);
        }));
    };
    const vacate = key => {
        (placedRects.get(key) || []).forEach(r => cellsOf(r).forEach(c => grid.get(c)?.delete(key)));
        placedRects.delete(key);
    };
    const fits = (rects, ignore) => rects.every(r => {
        for (const c of cellsOf(r)) {
            for (const other of grid.get(c) || []) {
                if (other === ignore) continue;
                if (placedRects.get(other).some(o => overlaps(r, o))) return false;
            }
        }
        return true;
    });
    occupy('storage', [storageRect]);

    // The cheapest place for piece `i`: each orientation is swept outward from the Storage Unit by
    // its weighted center, and once one fits, anything a little further out is still tried, since
    // a block's true cost is its members' own distances, not its center's.
    const place = i => {
        let best = null;
        for (const shape of shapes[i]) {
            let firstFit = null;
            for (const [ox, oy, distance] of offsets) {
                if (firstFit !== null && distance > firstFit + shape.spread + STEP) break;
                const x = snap(ox - shape.cx);
                const y = snap(oy - shape.cy);
                const rects = shape.members.map(m => ({ x: m.x + x, y: m.y + y, w: m.w, h: m.h }));
                if (!fits(rects, i)) continue;
                if (firstFit === null) firstFit = distance;
                const cost = shape.members.reduce((sum, m) => sum + m.weight * centerDistance(m, x, y), 0)
                    // Pieces nobody visits still go as close as they can, to keep the homeland tight.
                    + EPSILON * centerDistance({ x: shape.cx - STEP / 2, y: shape.cy - STEP / 2, w: STEP, h: STEP }, x, y);
                if (!best || cost < best.cost - EPSILON) best = { cost, x, y, shape, rects };
            }
        }
        return best;
    };

    const placed = new Map();
    for (const i of order) {
        const spot = place(i);
        placed.set(i, spot);
        occupy(i, spot.rects);
    }
    // Lift each piece and put it back where it's cheapest now, until a pass moves nothing.
    for (let pass = 0; pass < 6; pass++) {
        let moved = false;
        for (const i of order) {
            vacate(i);
            const spot = place(i);
            if (spot.cost < placed.get(i).cost - 1e-9) {
                placed.set(i, spot);
                moved = true;
            }
            occupy(i, placed.get(i).rects);
        }
        if (!moved) break;
    }

    return {
        storage: storageRect,
        pieces: pieces.map((piece, i) => {
            const spot = placed.get(i);
            return {
                ...piece,
                turns: spot.shape.turns,
                members: spot.shape.members.map((m, j) => ({ ...piece.members[j], x: m.x + spot.x, y: m.y + spot.y, w: m.w, h: m.h })),
                cost: spot.cost,
            };
        }),
    };
}

// The piece turned 0 to 3 quarter turns, each with its members' weighted center, used to sweep it
// outward, and how far its members spread from that center.
function orientations(members) {
    const seen = new Set();
    const out = [];
    for (let turns = 0; turns < 4; turns++) {
        const turned = members.map(m => turn(m, turns));
        const minX = Math.min(...turned.map(m => m.x));
        const minY = Math.min(...turned.map(m => m.y));
        const shifted = turned.map(m => ({ ...m, x: snap(m.x - minX), y: snap(m.y - minY) }));
        const key = shifted.map(m => `${m.x},${m.y},${m.w},${m.h}`).sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const weight = shifted.reduce((sum, m) => sum + m.weight, 0);
        const areaWeight = shifted.reduce((sum, m) => sum + m.w * m.h, 0);
        const by = weight > EPSILON ? (m => m.weight / weight) : (m => (m.w * m.h) / areaWeight);
        const cx = shifted.reduce((sum, m) => sum + by(m) * (m.x + m.w / 2), 0);
        const cy = shifted.reduce((sum, m) => sum + by(m) * (m.y + m.h / 2), 0);
        const spread = Math.max(...shifted.map(m => Math.hypot(m.x + m.w / 2 - cx, m.y + m.h / 2 - cy)));
        out.push({ turns, members: shifted, cx, cy, spread });
    }
    return out;
}

// A member turned `turns` quarter turns about its frame's origin.
function turn(m, turns) {
    let { x, y, w, h } = m;
    for (let t = 0; t < turns; t++) {
        [x, y, w, h] = [-(y + h), x, h, w];
    }
    return { ...m, x, y, w, h };
}

// Quarter-tile points out to `reach` tiles, nearest the origin first: `[x, y, distance]`.
function latticeByDistance(reach) {
    const points = [];
    const n = Math.ceil(reach / STEP);
    for (let i = -n; i <= n; i++) {
        for (let j = -n; j <= n; j++) {
            const x = i * STEP;
            const y = j * STEP;
            const distance = Math.hypot(x, y);
            if (distance <= reach) points.push([x, y, distance]);
        }
    }
    return points.sort((a, b) => a[2] - b[2]);
}

const snap = v => Math.round(v / STEP) * STEP;

function centerDistance(m, x, y) {
    return Math.hypot(m.x + x + m.w / 2, m.y + y + m.h / 2);
}

function overlaps(a, b) {
    return a.x < b.x + b.w - EPSILON && b.x < a.x + a.w - EPSILON && a.y < b.y + b.h - EPSILON && b.y < a.y + a.h - EPSILON;
}

function cellsOf(r) {
    const cells = [];
    for (let cx = Math.floor(r.x / CELL); cx <= Math.floor((r.x + r.w - EPSILON) / CELL); cx++) {
        for (let cy = Math.floor(r.y / CELL); cy <= Math.floor((r.y + r.h - EPSILON) / CELL); cy++) {
            cells.push(`${cx},${cy}`);
        }
    }
    return cells;
}
