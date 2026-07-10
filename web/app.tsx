'use client';

import { useEffect, useRef } from 'react';
import { mountApp } from './main';

export function VisualiserApp() {
  const rootRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!rootRef.current || mountedRef.current) return;
    mountedRef.current = true;
    mountApp(rootRef.current);
  }, []);

  return <div id="app" ref={rootRef} />;
}
