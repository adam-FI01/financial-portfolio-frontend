import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

export interface DonutSegment {
  label: string;
  total: number;
  percent: number;
  color: string;
}

// Validated categorical palette (dark-mode steps), skipping the palette's green
// slot since green is reserved elsewhere in this app for CTAs/success states.
// Passes all six dataviz checks (lightness, chroma, CVD, contrast) against our
// dark surface — see the palette validation run for this feature.
export const DONUT_COLORS = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#9085e9', // violet
  '#e66767' // red
];
export const DONUT_OTHER_COLOR = '#6b7280'; // neutral gray — matches --color-text-tertiary

export function buildDonutGradient(segments: DonutSegment[]): string {
  if (segments.length === 0) {
    return 'transparent';
  }
  if (segments.length === 1) {
    return segments[0].color;
  }

  const gapDeg = 2.5;
  let cursor = 0;
  const stops: string[] = [];

  for (const segment of segments) {
    const sweep = (segment.percent / 100) * 360;
    const start = cursor;
    const end = cursor + sweep;
    const gapStart = Math.max(start, end - gapDeg);
    stops.push(`${segment.color} ${start}deg ${gapStart}deg`);
    stops.push(`var(--color-surface) ${gapStart}deg ${end}deg`);
    cursor = end;
  }

  return `conic-gradient(${stops.join(', ')})`;
}

@Component({
  selector: 'app-donut-chart',
  standalone: true,
  imports: [CurrencyPipe, DecimalPipe],
  templateUrl: './donut-chart.html',
  styleUrl: './donut-chart.scss'
})
export class DonutChart {
  readonly segments = input.required<DonutSegment[]>();
  readonly centerValue = input<string | null>('');
  readonly centerLabel = input<string>('');

  readonly gradient = computed(() => buildDonutGradient(this.segments()));
}
