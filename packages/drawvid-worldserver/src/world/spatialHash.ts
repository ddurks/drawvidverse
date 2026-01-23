import { Vec3 } from './colliders';

export class SpatialHash {
  private cellSize: number;
  private cells: Map<string, Set<string>>;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  insert(id: string, position: Vec3): void {
    const key = this.getCellKey(position);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = new Set();
      this.cells.set(key, cell);
    }
    cell.add(id);
  }

  remove(id: string, position: Vec3): void {
    const key = this.getCellKey(position);
    const cell = this.cells.get(key);
    if (cell) {
      cell.delete(id);
      if (cell.size === 0) {
        this.cells.delete(key);
      }
    }
  }

  update(id: string, oldPosition: Vec3, newPosition: Vec3): void {
    const oldKey = this.getCellKey(oldPosition);
    const newKey = this.getCellKey(newPosition);

    if (oldKey !== newKey) {
      this.remove(id, oldPosition);
      this.insert(id, newPosition);
    }
  }

  queryRadius(position: Vec3, radius: number): Set<string> {
    const result = new Set<string>();
    const cellRadius = Math.ceil(radius / this.cellSize);

    const centerCell = this.getCell(position);

    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dz = -cellRadius; dz <= cellRadius; dz++) {
        const key = this.makeCellKey(centerCell.x + dx, centerCell.z + dz);
        const cell = this.cells.get(key);
        if (cell) {
          cell.forEach((id) => result.add(id));
        }
      }
    }

    return result;
  }

  private getCellKey(position: Vec3): string {
    const cell = this.getCell(position);
    return this.makeCellKey(cell.x, cell.z);
  }

  private getCell(position: Vec3): { x: number; z: number } {
    return {
      x: Math.floor(position.x / this.cellSize),
      z: Math.floor(position.z / this.cellSize),
    };
  }

  private makeCellKey(x: number, z: number): string {
    return `${x},${z}`;
  }

  clear(): void {
    this.cells.clear();
  }
}
