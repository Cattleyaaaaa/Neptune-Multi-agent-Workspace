"use client";

/* Neptune 的品牌标记：三叉戟。

   与浏览器图标（app/icon.svg）**同形同源** —— 改一处请同步另一份；
   两边的 path/@d 必须逐字一致（可用 grep 'd="M6.5' 核对）。

   结构说明写在 icon.svg 的注释里：左右对称轴 x=16、墨迹外框 22×22 居中、
   横档是三叉的基线与结构脊、头与横档一笔连描、柄沿中轴下行。
   用 currentColor 描边，放在哪个底色方块里就继承哪个颜色。 */

export function BrandMark({ size = 20 }: { size?: number }) {
  return <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 11 9.5 14.5V18H22.5V14.5L25.5 11" />
      <path d="M16 6.5V25.5" />
    </g>
  </svg>;
}
