import type { ButtonHTMLAttributes } from 'react'

// The three brand button treatments from the Rallypoint Minimal design system:
//  - 'brutal' (default): solid accent, offset hard shadow — primary CTA
//  - 'ghost': outlined, mono label — secondary action
//  - 'hot': solid red — destructive action
// Thin wrapper over the `.btn-*` classes in `theme.css` so apps don't
// hand-type class names. Forwards all native button props.

export type ButtonVariant = 'brutal' | 'ghost' | 'hot'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  brutal: 'btn-brutal',
  ghost: 'btn-ghost',
  hot: 'btn-hot',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  // When true, prefixes a dot and disables the button — the
  // pending-submit affordance the id-web auth forms rely on.
  loading?: boolean
}

export function Button({
  variant = 'brutal',
  loading,
  disabled,
  className,
  type,
  children,
  ...rest
}: ButtonProps) {
  const cls = className ? `${VARIANT_CLASS[variant]} ${className}` : VARIANT_CLASS[variant]
  return (
    <button
      type={type ?? 'button'}
      className={cls}
      disabled={disabled || loading}
      {...(loading !== undefined ? { 'aria-busy': loading } : {})}
      {...rest}
    >
      {loading ? (
        <span aria-hidden style={{ marginRight: 8 }}>
          ●
        </span>
      ) : null}
      {children}
    </button>
  )
}
