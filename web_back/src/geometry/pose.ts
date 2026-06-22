// 2D 자세 기하 값 객체.
//
// 그동안 여러 파일에 흩어져 중복되던 쿼터니언↔오일러각 변환과 거리/방위 계산을
// 한 곳에 캡슐화한다. 의존성이 없는 순수 값 객체라 ros/fleet/fms 어디서나 쓴다.

/** 쿼터니언 값 객체 (ROS orientation) */
export class Quaternion {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
    readonly w: number,
  ) {}

  /** yaw(rad) → 평면 회전 쿼터니언 */
  static fromYaw(yaw: number): Quaternion {
    return new Quaternion(0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2));
  }

  /** ROS 메시지의 orientation 객체(부분적일 수 있음) → 쿼터니언 */
  static from(ori: { x?: number; y?: number; z?: number; w?: number } | undefined | null): Quaternion {
    return new Quaternion(ori?.x ?? 0, ori?.y ?? 0, ori?.z ?? 0, ori?.w ?? 1);
  }

  /** ROS 메시지에 넣을 평문 객체 */
  toObject(): { x: number; y: number; z: number; w: number } {
    return { x: this.x, y: this.y, z: this.z, w: this.w };
  }

  get yaw(): number {
    return Math.atan2(
      2 * (this.w * this.z + this.x * this.y),
      1 - 2 * (this.y * this.y + this.z * this.z),
    );
  }

  get roll(): number {
    return Math.atan2(
      2 * (this.w * this.x + this.y * this.z),
      1 - 2 * (this.x * this.x + this.y * this.y),
    );
  }

  get pitch(): number {
    const sinp = 2 * (this.w * this.y - this.z * this.x);
    return Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
  }
}

/** 평면 위치+헤딩 값 객체 */
export class Pose {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly yaw: number = 0,
  ) {}

  /** 다른 점까지의 평면 거리(m) */
  distanceTo(o: { x: number; y: number }): number {
    return Math.hypot(this.x - o.x, this.y - o.y);
  }

  /** 다른 점을 향하는 방위각(rad) */
  headingTo(o: { x: number; y: number }): number {
    return Math.atan2(o.y - this.y, o.x - this.x);
  }
}

/** 각도를 [-π, π] 범위로 정규화 */
export function normalizeAngle(a: number): number {
  while (a >  Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
