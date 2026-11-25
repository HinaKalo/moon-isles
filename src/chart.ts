import { LOCATIONS, type Location } from './rules.ts';

export const POSITIONS: Record<Location, [number, number]> = {
  port: [17, 69], north: [34, 30], east: [57, 73], outer: [69, 26], south: [85, 58],
};
export const PORTS = Object.keys(POSITIONS) as Location[];

export function drawChart(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width = 960;
  const height = canvas.height = 600;
  const sea = ctx.createRadialGradient(440, 317, 30, 440, 317, 650);
  sea.addColorStop(0, '#154756');
  sea.addColorStop(1, '#092631');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#a2d5cb1b';
  for (let x = 0; x < width; x += 38) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y < height; y += 38) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  for (const [index, station] of PORTS.entries()) {
    const [x, y] = POSITIONS[station].map((part, axis) => part * (axis ? height : width) / 100);
    for (const radius of [1.38, 1.9, 2.52, 3.3]) {
      ctx.beginPath();
      for (let step = 0; step <= 64; step++) {
        const angle = step * Math.PI / 32;
        const coast = 1 + Math.cos(3 * angle + index) * .17 + Math.sin(5 * angle + index) * .14;
        const px = x + Math.cos(angle) * 32 * radius * coast;
        const py = y + Math.sin(angle) * 18 * radius * coast;
        if (step === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.strokeStyle = '#75aaa458';
      ctx.stroke();
    }
  }

  ctx.strokeStyle = '#e3d5a5bb';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 7]);
  for (const [i, from] of PORTS.entries()) {
    for (const to of LOCATIONS[from].exits) {
      if (PORTS.indexOf(to) <= i) continue;
      ctx.beginPath();
      ctx.moveTo(POSITIONS[from][0] * width / 100, POSITIONS[from][1] * height / 100);
      ctx.lineTo(POSITIONS[to][0] * width / 100, POSITIONS[to][1] * height / 100);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  ctx.translate(104, 96);
  ctx.strokeStyle = '#a7d3c8aa';
  for (const radius of [31, 37]) {
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0, -29); ctx.lineTo(8, 0); ctx.lineTo(0, 29); ctx.lineTo(-8, 0); ctx.closePath();
  ctx.fillStyle = '#e6cb8f'; ctx.fill();
  ctx.fillStyle = '#d7f1e4'; ctx.font = '19px Georgia'; ctx.textAlign = 'center';
  ctx.fillText('N', 0, -45);
}
