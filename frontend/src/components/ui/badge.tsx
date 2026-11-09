import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  readonly tone?: 'neutral' | 'success' | 'info' | 'warning' | 'danger';
};
const tones = {
  neutral: 'border-[var(--border)] bg-[var(--raised)] text-[var(--muted)]',
  success: 'border-[#355644] bg-[#15241D] text-[var(--success)]',
  info: 'border-[#33455F] bg-[#161F2B] text-[var(--info)]',
  warning: 'border-[#5A4938] bg-[#292016] text-[var(--accent)]',
  danger: 'border-[#60363A] bg-[#2A191B] text-[var(--error)]',
} as const;
export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
