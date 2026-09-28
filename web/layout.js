// Places a whole homeland around a single Storage Unit, so the Aniimo hauling each finished batch
// walk as little as they can: a piece's cost is its trips (finished batches) per hour times its
// straight-line distance to the Storage Unit, center to center, and the layout keeps the total low.
//
// Environment buildings keep every plot the plan gives them covered as planned, but not in any set
// arrangement: a plot may go anywhere its footprint overlaps its building's 9x9 coverage square by
// a real area (the rule in coverage.rs), or for two buildings placed to overlap, the zone the plan
// gives it (the first's alone, both, or the second's alone). Temperatures add up where squares
// meet, so no covered plot reaches another building's square, and the squares of different
// buildings don't overlap. Crops the plan grows with no building of their own stay out of every
// square too, so none picks up a temperature it wasn't planned for. Anything else may stand
// anywhere. Pieces may touch but not overlap, sit on a quarter-tile grid (the smallest step in
// any footprint), and may be turned a quarter at a time.
//
// Busiest pieces for their size go down first, each where it costs least; then each is lifted
// and put back wherever is cheapest with the rest in place, until nothing moves. This is a
// heuristic: it finds a good layout, not a proven best one.

const STEP = 0.25;
const EPSILON = 1e-6;
const CELL = 4;
const RADIUS = 4.5;
// Building positions tried past the first that works, since a building's plots can go anywhere
// in its square and the nearest building isn't always the cheapest; of those, how many also try
// packing the plots afresh, which is slow and seldom beats the plan's own arrangement when a
// building covers many plots.
const CLUSTER_TRIES = 24;
const CLUSTER_PACKS = 2;
const CLUSTER_PACK_MOST = 12;

// `pieces`: each either
// - `{ members: [{ x, y, w, h, weight, sensitive }] }`, one rigid piece (a facility unit), whose
//   members are relative to its own frame; `sensitive` members stay out of every coverage square;
// - `{ cluster: true, buildings: [{ x, y, w, h }], plots: [{ w, h, weight, zone }], planned:
//   [{ x, y }] }`, environment buildings (one, or two placed to overlap) with the plots they
//   cover: `zone` is 0 for a lone building's plots, else 0, 1 or 2 for the first's zone, the
//   shared one and the second's; `planned` is each plot's place in the plan's own arrangement,
//   in the buildings' frame, used when the plots can't be packed any other way.
// Returns `{ storage, pieces }`, each piece with its members (a cluster's buildings then plots)
// at their final places and its cost.
export function layOut(pieces, storage = { w: 2, h: 2 }, passes = 6) {
    const storageRect = { x: -storage.w / 2, y: -storage.h / 2, w: storage.w, h: storage.h };
    const shapes = pieces.map(piece => (piece.cluster ? clusterOrientations(piece) : orientations(piece.members)));
    const membersOf = piece => (piece.cluster ? [...piece.buildings.map(b => ({ ...b, weight: 0 })), ...piece.plots] : piece.members);
    const weightOf = piece => membersOf(piece).reduce((sum, m) => sum + m.weight, 0);
    const areaOf = piece => membersOf(piece).reduce((sum, m) => sum + m.w * m.h, 0);
    const order = pieces
        .map((piece, i) => ({ i, density: weightOf(piece) / Math.max(areaOf(piece), EPSILON) }))
        .sort((a, b) => b.density - a.density || areaOf(pieces[b.i]) - areaOf(pieces[a.i]))
        .map(p => p.i);

    const totalArea = pieces.reduce((sum, p) => sum + areaOf(p), 0) + storage.w * storage.h;
    const reach = Math.ceil(Math.sqrt(totalArea) * 1.6 + 16);
    const offsets = latticeByDistance(reach, STEP);
    // Environment buildings stand on whole tiles, which is plenty for them and far fewer to try.
    const clusterOffsets = latticeByDistance(reach, 1);

    // What's down: rectangles by piece, found through a coarse grid; coverage squares by cluster;
    // and the rectangles that must stay out of every square.
    const grid = new Map();
    const placedRects = new Map();
    const squares = new Map();
    const sensitive = new Map();
    const occupy = (key, spot) => {
        placedRects.set(key, spot.rects);
        spot.rects.forEach(r => cellsOf(r).forEach(c => {
            if (!grid.has(c)) grid.set(c, new Set());
            grid.get(c).add(key);
        }));
        if (spot.squares) squares.set(key, spot.squares);
        if (spot.sensitive?.length) sensitive.set(key, spot.sensitive);
    };
    const vacate = key => {
        (placedRects.get(key) || []).forEach(r => cellsOf(r).forEach(c => grid.get(c)?.delete(key)));
        placedRects.delete(key);
        squares.delete(key);
        sensitive.delete(key);
    };
    const free = (r, ignore, extra = []) => {
        for (const c of cellsOf(r)) {
            for (const other of grid.get(c) || []) {
                if (other === ignore) continue;
                if (placedRects.get(other).some(o => overlaps(r, o))) return false;
            }
        }
        return !extra.some(o => overlaps(r, o));
    };
    const inOtherSquare = (r, ignore) => {
        for (const [key, list] of squares) {
            if (key !== ignore && list.some(s => overlaps(r, s))) return true;
        }
        return false;
    };
    occupy('storage', { rects: [storageRect] });

    const placeRigid = i => {
        let best = null;
        for (const shape of shapes[i]) {
            let firstFit = null;
            for (const [ox, oy, distance] of offsets) {
                if (firstFit !== null && distance > firstFit + shape.spread + STEP) break;
                const x = snap(ox - shape.cx);
                const y = snap(oy - shape.cy);
                const rects = shape.members.map(m => ({ x: m.x + x, y: m.y + y, w: m.w, h: m.h }));
                if (!rects.every(r => free(r, i))) continue;
                const touchy = rects.filter((r, j) => shape.members[j].sensitive);
                if (touchy.some(r => inOtherSquare(r, i))) continue;
                if (firstFit === null) firstFit = distance;
                const cost = shape.members.reduce((sum, m) => sum + m.weight * centerDistance(m, x, y), 0)
                    // Pieces nobody visits still go as close as they can, to keep the homeland tight.
                    + EPSILON * Math.hypot(shape.cx + x, shape.cy + y);
                if (!best || cost < best.cost - EPSILON) best = { cost, x, y, shape, rects, sensitive: touchy };
            }
        }
        return best;
    };

    // A cluster's buildings at `(x, y)` in orientation `shape`, with its plots in the plan's own
    // arrangement (turned with it), the busiest crops on the plots nearest the Storage Unit; with
    // `pack`, also packed afresh nearest the Storage Unit within their zones, if that's cheaper.
    const tryCluster = (i, shape, x, y, pack, clear) => {
        const buildings = shape.buildings.map(b => ({ x: b.x + x, y: b.y + y, w: b.w, h: b.h }));
        const own = buildings.map(b => ({ x: b.x + b.w / 2 - RADIUS, y: b.y + b.h / 2 - RADIUS, w: 2 * RADIUS, h: 2 * RADIUS }));
        if (!clear(buildings, own)) return null;
        const allowed = (r, zone) => {
            const inside = shape.pair ? [[0], [0, 1], [1]][zone] : [0];
            const outside = shape.pair ? [[1], [], [0]][zone] : [];
            return inside.every(k => overlaps(r, own[k])) && outside.every(k => !overlaps(r, own[k])) && !inOtherSquare(r, i);
        };
        const costOf = rects => shape.plots.reduce((sum, p, j) => sum + p.weight * Math.hypot(rects[j].x + p.w / 2, rects[j].y + p.h / 2), 0);
        let plots = null;
        const slots = shape.plots.map((p, j) => ({ x: shape.planned[j].x + x, y: shape.planned[j].y + y, w: p.w, h: p.h }));
        if (slots.every(r => free(r, i) && !buildings.some(b => overlaps(r, b)))) {
            plots = assignSlots(shape.plots, slots);
            if (!plots.every((r, j) => allowed(r, shape.plots[j].zone))) plots = null;
        }
        // Packing afresh is only tried where the plan's arrangement fits: in crowded ground it
        // mostly fails, and failing is the slow part.
        if (pack && plots) {
            const packed = packPlots(shape.plots, own, allowed, r => free(r, i), buildings);
            if (packed && (!plots || costOf(packed) < costOf(plots) - EPSILON)) plots = packed;
        }
        if (!plots) return null;
        return { cost: costOf(plots), x, y, shape, rects: [...buildings, ...plots], squares: own, sensitive: plots };
    };

    const placeCluster = i => {
        let best = null;
        // Whether buildings standing here are clear, with their squares clear of every other
        // building's square and every crop that must stay uncovered. A lone building stands in
        // the same place in every orientation, so each place is worked out once.
        const known = new Map();
        const clear = (buildings, own) => {
            const key = buildings.map(b => `${b.x},${b.y},${b.w}`).join('|');
            if (!known.has(key)) {
                known.set(key, buildings.every(r => free(r, i))
                    && ![...squares].some(([k, list]) => k !== i && list.some(s => own.some(o => overlaps(o, s))))
                    && ![...sensitive].some(([k, list]) => k !== i && list.some(r => own.some(o => overlaps(o, r)))));
            }
            return known.get(key);
        };
        for (const shape of shapes[i]) {
            let tried = 0;
            for (const [ox, oy] of clusterOffsets) {
                if (tried >= CLUSTER_TRIES) break;
                const pack = tried < CLUSTER_PACKS && shape.plots.length <= CLUSTER_PACK_MOST;
                const spot = tryCluster(i, shape, Math.round(ox - shape.cx), Math.round(oy - shape.cy), pack, clear);
                if (!spot) continue;
                tried++;
                if (!best || spot.cost < best.cost - EPSILON) best = spot;
            }
        }
        return best;
    };

    const place = i => (pieces[i].cluster ? placeCluster(i) : placeRigid(i));
    const placed = new Map();
    for (const i of order) {
        const spot = place(i);
        if (!spot) throw new Error('no room found for a piece; the search area is too small');
        placed.set(i, spot);
        occupy(i, spot);
    }
    // Lift each piece and put it back where it's cheapest now, until a pass moves nothing.
    for (let pass = 0; pass < passes; pass++) {
        let moved = false;
        for (const i of order) {
            vacate(i);
            const spot = place(i);
            if (spot && spot.cost < placed.get(i).cost - 1e-9) {
                placed.set(i, spot);
                moved = true;
            }
            occupy(i, placed.get(i));
        }
        if (!moved) break;
    }

    return {
        storage: storageRect,
        pieces: pieces.map((piece, i) => {
            const spot = placed.get(i);
            const source = piece.cluster ? [...piece.buildings, ...piece.plots] : piece.members;
            return {
                ...piece,
                members: spot.rects.map((r, j) => ({ ...source[j], x: r.x, y: r.y, w: r.w, h: r.h })),
                cost: spot.cost,
            };
        }),
    };
}

// Puts `plots` on `slots` (the plan's own arrangement, one slot per plot, each slot sized for the
// plot that had it): within each facility and zone, the busiest crop takes the slot nearest the
// Storage Unit.
function assignSlots(plots, slots) {
    const result = new Array(plots.length);
    const groups = new Map();
    plots.forEach((p, j) => {
        const key = `${p.facility}|${p.zone}|${p.w}x${p.h}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(j);
    });
    for (const members of groups.values()) {
        const nearest = members.map(j => slots[j]).sort((a, b) => Math.hypot(a.x + a.w / 2, a.y + a.h / 2) - Math.hypot(b.x + b.w / 2, b.y + b.h / 2));
        const busiest = [...members].sort((a, b) => plots[b].weight - plots[a].weight);
        busiest.forEach((j, k) => { result[j] = nearest[k]; });
    }
    return result;
}

// Packs `plots` (busiest first) where `allowed(rect, zone)` and `free(rect)`, each at the spot
// nearest the Storage Unit, around the cluster's squares; null if one doesn't fit.
function packPlots(plots, squares, allowed, free, buildings) {
    const minX = Math.min(...squares.map(s => s.x));
    const minY = Math.min(...squares.map(s => s.y));
    const maxX = Math.max(...squares.map(s => s.x + s.w));
    const maxY = Math.max(...squares.map(s => s.y + s.h));
    const result = new Array(plots.length);
    const taken = [...buildings];
    const order = plots.map((p, j) => j).sort((a, b) => plots[b].weight - plots[a].weight);
    // Every spot a plot of each size could take, nearest the Storage Unit first.
    const spots = new Map();
    const spotsFor = (w, h) => {
        const key = `${w}x${h}`;
        if (!spots.has(key)) {
            const list = [];
            for (let x = snap(minX - w + STEP); x <= maxX - STEP + EPSILON; x += STEP) {
                for (let y = snap(minY - h + STEP); y <= maxY - STEP + EPSILON; y += STEP) {
                    list.push({ x, y, w, h, distance: Math.hypot(x + w / 2, y + h / 2) });
                }
            }
            spots.set(key, list.sort((a, b) => a.distance - b.distance));
        }
        return spots.get(key);
    };
    for (const j of order) {
        const p = plots[j];
        const r = spotsFor(p.w, p.h).find(r => allowed(r, p.zone) && !taken.some(t => overlaps(r, t)) && free(r));
        if (!r) return null;
        result[j] = { x: r.x, y: r.y, w: r.w, h: r.h };
        taken.push(result[j]);
    }
    return result;
}

// A rigid piece turned 0 to 3 quarter turns, each with its members' weighted center, used to
// sweep it outward, and how far its members spread from that center.
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

// A cluster turned 0 to 3 quarter turns and mirrored or not, which turns its plan's arrangement
// with it; swept outward by its first building's center.
function clusterOrientations(cluster) {
    const pair = cluster.buildings.length > 1;
    const out = [];
    const mirror = r => ({ ...r, x: -(r.x + r.w) });
    for (let variant = 0; variant < 8; variant++) {
        const turns = variant % 4;
        const flip = variant >= 4 ? mirror : (r => r);
        const buildings = cluster.buildings.map(b => turn(flip(b), turns));
        const planned = cluster.plots.map((p, j) => turn(flip({ ...cluster.planned[j], w: p.w, h: p.h }), turns));
        const minX = Math.min(...buildings.map(b => b.x));
        const minY = Math.min(...buildings.map(b => b.y));
        const shift = r => ({ ...r, x: snap(r.x - minX), y: snap(r.y - minY) });
        const shifted = buildings.map(shift);
        out.push({
            turns,
            pair,
            buildings: shifted,
            plots: cluster.plots,
            planned: planned.map(shift),
            cx: shifted[0].x + shifted[0].w / 2,
            cy: shifted[0].y + shifted[0].h / 2,
        });
    }
    return out;
}

// A rectangle turned `turns` quarter turns about its frame's origin.
function turn(m, turns) {
    let { x, y, w, h } = m;
    for (let t = 0; t < turns; t++) {
        [x, y, w, h] = [-(y + h), x, h, w];
    }
    return { ...m, x, y, w, h };
}

// Points `step` tiles apart out to `reach` tiles, nearest the origin first: `[x, y, distance]`.
function latticeByDistance(reach, step) {
    const points = [];
    const n = Math.ceil(reach / step);
    for (let i = -n; i <= n; i++) {
        for (let j = -n; j <= n; j++) {
            const x = i * step;
            const y = j * step;
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
