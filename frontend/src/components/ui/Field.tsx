import {
  cloneElement, forwardRef, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { AlertCircle, ChevronDown, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface FieldProps {
  label?: ReactNode;
  /** Hint under the control. Replaced by `error` when present. */
  helper?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Visually hide the label (still read by screen readers). */
  hideLabel?: boolean;
  /** Right side of the label row (e.g. "Forgot?" link, counter). */
  labelAside?: ReactNode;
  id?: string;
  className?: string;
  children: ReactElement<Record<string, unknown>>;
}

/** Label + control + helper/error wiring (ids, aria-invalid, aria-describedby). Wrap any single control. */
export function Field({ label, helper, error, required, hideLabel, labelAside, id: idProp, className, children }: FieldProps) {
  const auto = useId();
  const id = idProp ?? (children.props.id as string | undefined) ?? auto;
  const descId = `${id}-desc`;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error || helper ? descId : undefined,
        required: required ?? children.props.required,
      })
    : children;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <div className={cn('flex items-baseline justify-between gap-2', hideLabel && 'sr-only')}>
          <label htmlFor={id} className="text-sm font-semibold text-ink-700">
            {label}{required && <span className="ml-0.5 text-brand-500" aria-hidden>*</span>}
          </label>
          {labelAside}
        </div>
      )}
      {control}
      {(error || helper) && (
        <p id={descId} className={cn('flex items-start gap-1 text-xs', error ? 'font-medium text-danger-fg' : 'text-ink-500')} role={error ? 'alert' : undefined}>
          {error && <AlertCircle size={14} className="mt-px shrink-0" aria-hidden />}
          {error || helper}
        </p>
      )}
    </div>
  );
}

const control = (invalid: boolean, extra?: string) => cn(
  'w-full rounded-md border bg-surface text-base text-ink-900 placeholder:text-ink-400 transition-[border-color,box-shadow] duration-micro',
  'focus:outline-none focus:border-brand-500 focus:shadow-focus disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-500',
  invalid ? 'border-brand-500' : 'border-line-strong hover:border-ink-400',
  extra,
);

type FieldPassthrough = Pick<FieldProps, 'label' | 'helper' | 'error' | 'hideLabel' | 'labelAside'>;

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, FieldPassthrough {
  /** Leading icon inside the field. */
  icon?: LucideIcon;
  /** Trailing slot inside the field (button, unit, clear). */
  trailing?: ReactNode;
  size?: 'md' | 'lg';
  wrapperClassName?: string;
}

/** Text input with label/helper/error. 16px text (no iOS zoom). */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, helper, error, hideLabel, labelAside, icon: Icon, trailing, size = 'md', className, wrapperClassName, id, required, ...rest },
  ref,
) {
  const { fid, aria } = useFieldIds(id, error, helper);
  const el = (
    <div className="relative">
      {Icon && <Icon size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />}
      <input
        ref={ref}
        {...aria}
        required={required}
        className={control(!!error, cn(size === 'lg' ? 'h-14 px-4' : 'h-12 px-3.5', Icon && (size === 'lg' ? 'pl-11' : 'pl-10'), trailing ? 'pr-12' : '', className))}
        {...rest}
      />
      {trailing && <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div>}
    </div>
  );
  if (!label && !helper && !error) return <div className={wrapperClassName}>{el}</div>;
  return <FieldFrame {...{ label, helper, error, hideLabel, labelAside, required, id: fid, className: wrapperClassName }}>{el}</FieldFrame>;
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldPassthrough {
  options?: { value: string | number; label: string; disabled?: boolean }[];
  placeholder?: string;
  wrapperClassName?: string;
}

/** Native select (best on mobile) with consistent styling. Pass `options` or <option> children. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, helper, error, hideLabel, labelAside, options, placeholder, className, wrapperClassName, id, required, children, ...rest },
  ref,
) {
  const { fid, aria } = useFieldIds(id, error, helper);
  const el = (
    <div className="relative">
      <select ref={ref} {...aria} required={required} className={control(!!error, cn('h-12 appearance-none pl-3.5 pr-10', className))} {...rest}>
        {placeholder && <option value="" disabled>{placeholder}</option>}
        {options?.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        {children}
      </select>
      <ChevronDown size={18} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-500" aria-hidden />
    </div>
  );
  if (!label && !helper && !error) return <div className={wrapperClassName}>{el}</div>;
  return <FieldFrame {...{ label, helper, error, hideLabel, labelAside, required, id: fid, className: wrapperClassName }}>{el}</FieldFrame>;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldPassthrough {
  wrapperClassName?: string;
  /** Show "12/200" counter when maxLength is set. */
  showCount?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, helper, error, hideLabel, labelAside, className, wrapperClassName, id, required, showCount, rows = 3, ...rest },
  ref,
) {
  const count = showCount && rest.maxLength ? (
    <span className="text-xs tabular-nums text-ink-500">{String(rest.value ?? '').length}/{rest.maxLength}</span>
  ) : undefined;
  const { fid, aria } = useFieldIds(id, error, helper);
  const el = <textarea ref={ref} {...aria} rows={rows} required={required} className={control(!!error, cn('min-h-[96px] resize-y px-3.5 py-3', className))} {...rest} />;
  if (!label && !helper && !error) return <div className={wrapperClassName}>{el}</div>;
  return <FieldFrame {...{ label, helper, error, hideLabel, labelAside: labelAside ?? count, required, id: fid, className: wrapperClassName }}>{el}</FieldFrame>;
});

/** Label + helper/error frame around an already-wired control (ids are set by the caller). */
function FieldFrame({ id, children, ...p }: Omit<FieldProps, 'children' | 'id'> & { id: string; children: ReactNode }) {
  return (
    <div className={cn('flex flex-col gap-1.5', p.className)}>
      {p.label && (
        <div className={cn('flex items-baseline justify-between gap-2', p.hideLabel && 'sr-only')}>
          <label htmlFor={id} className="text-sm font-semibold text-ink-700">
            {p.label}{p.required && <span className="ml-0.5 text-brand-500" aria-hidden>*</span>}
          </label>
          {p.labelAside}
        </div>
      )}
      {children}
      {(p.error || p.helper) && (
        <p id={`${id}-desc`} className={cn('flex items-start gap-1 text-xs', p.error ? 'font-medium text-danger-fg' : 'text-ink-500')} role={p.error ? 'alert' : undefined}>
          {p.error && <AlertCircle size={14} className="mt-px shrink-0" aria-hidden />}
          {p.error || p.helper}
        </p>
      )}
    </div>
  );
}

/** aria wiring shared by Input/Select/Textarea. */
function useFieldIds(id: string | undefined, error: ReactNode, helper: ReactNode) {
  const auto = useId();
  const fid = id ?? auto;
  return {
    fid,
    aria: {
      id: fid,
      'aria-invalid': error ? (true as const) : undefined,
      'aria-describedby': error || helper ? `${fid}-desc` : undefined,
    },
  };
}
