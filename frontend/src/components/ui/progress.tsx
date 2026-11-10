import * as ProgressPrimitive from '@radix-ui/react-progress';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type ProgressProps = ComponentProps<typeof ProgressPrimitive.Root> & {
  readonly indicatorClassName?: string;
};
export function Progress({
  className,
  indicatorClassName,
  value = 0,
  ...props
}: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      className={cn(
        'h-1.5 w-full overflow-hidden rounded-full bg-[var(--raised)]',
        className,
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full bg-[var(--accent)] transition-transform',
          indicatorClassName,
        )}
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
