"use client";

/** Consistent instant-search control for high-volume PMS lists. */

import { useRef } from "react";

type ListSearchProps = {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  count: number;
  className?: string;
};

export function ListSearch({ value, onChange, label, placeholder, count, className = "" }: ListSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <div className={`list-search ${className}`.trim()} role="search">
    <span aria-hidden="true">⌕</span>
    <input
      ref={inputRef}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
    />
    <em aria-live="polite">{count.toLocaleString()}건</em>
    {value&&<button type="button" aria-label={`${label} 지우기`} onClick={()=>{onChange("");inputRef.current?.focus();}}>×</button>}
  </div>;
}
