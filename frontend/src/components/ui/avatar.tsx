import * as AvatarPrimitive from '@radix-ui/react-avatar';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Avatar({
  className,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn(
        'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--raised)] text-[10px] font-semibold text-[var(--text)]',
        className,
      )}
      {...props}
    />
  );
}
export function AvatarImage(
  props: ComponentProps<typeof AvatarPrimitive.Image>,
) {
  return (
    <AvatarPrimitive.Image className="aspect-square size-full" {...props} />
  );
}
export function AvatarFallback({
  className,
  ...props
}: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn('flex size-full items-center justify-center', className)}
      {...props}
    />
  );
}
