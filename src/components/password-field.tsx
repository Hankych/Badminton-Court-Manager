"use client";

import { useId, useState } from "react";

/** Standard open eye — click to reveal password. */
function IconEye(props: { className?: string }) {
  return (
    <svg className={props.className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.962-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

/** Slashed eye — password visible; click to hide. */
function IconEyeOff(props: { className?: string }) {
  return (
    <svg className={props.className} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"
      />
    </svg>
  );
}

type PasswordFieldProps = {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  autoComplete?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
};

export function PasswordField({ id: idProp, value, onChange, autoComplete, placeholder, className, inputClassName }: PasswordFieldProps) {
  const genId = useId();
  const id = idProp ?? genId;
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-lg border border-zinc-300 bg-white py-2 pl-3 pr-11 text-sm text-zinc-900 shadow-sm outline-none ring-emerald-500/20 placeholder:text-zinc-400 focus:border-emerald-500 focus:ring-2 ${inputClassName ?? ""}`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 touch-manipulation items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline focus-visible:ring-2 focus-visible:ring-emerald-500"
        aria-label={visible ? "Hide password" : "Show password"}
      >
        {visible ? <IconEyeOff className="size-5" /> : <IconEye className="size-5" />}
      </button>
    </div>
  );
}
