'use client';

import { createContext, useContext } from 'react';
import type { Me } from './api';

/** The signed-in principal, provided by the app layout and read by any client screen. */
export const MeContext = createContext<Me | null>(null);

export const useMe = (): Me | null => useContext(MeContext);
