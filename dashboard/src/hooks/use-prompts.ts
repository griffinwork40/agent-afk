import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { PromptEntryWire, PromptDetailWire } from '@/types/api';

interface PromptsResponse {
  prompts: PromptEntryWire[];
}

interface PromptDetailResponse {
  prompt: PromptDetailWire;
}

const DEBOUNCE_MS = 300;

export interface UsePromptsResult {
  prompts: PromptEntryWire[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedPrompt: PromptDetailWire | null;
  loadingDetail: boolean;
  selectPrompt: (id: string) => void;
  clearSelection: () => void;
  refresh: () => void;
}

export function usePrompts(): UsePromptsResult {
  const [prompts, setPrompts] = useState<PromptEntryWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPrompt, setSelectedPrompt] = useState<PromptDetailWire | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<PromptsResponse>('/api/prompts');
      setPrompts(data.prompts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch prompts');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSearch = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<PromptsResponse>(
        `/api/prompts/search?q=${encodeURIComponent(q)}`,
      );
      setPrompts(data.prompts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // Debounced search
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (searchQuery.trim() === '') {
      void fetchAll();
      return;
    }
    debounceRef.current = setTimeout(() => {
      void fetchSearch(searchQuery);
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [searchQuery, fetchAll, fetchSearch]);

  const selectPrompt = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const data = await apiFetch<PromptDetailResponse>(`/api/prompts/${encodeURIComponent(id)}`);
      setSelectedPrompt(data.prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prompt');
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const clearSelection = useCallback(() => setSelectedPrompt(null), []);

  const refresh = useCallback(() => {
    if (searchQuery.trim()) void fetchSearch(searchQuery);
    else void fetchAll();
  }, [searchQuery, fetchAll, fetchSearch]);

  return {
    prompts,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    selectedPrompt,
    loadingDetail,
    selectPrompt,
    clearSelection,
    refresh,
  };
}
