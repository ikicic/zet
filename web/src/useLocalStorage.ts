import { useState, useCallback } from "react";

interface UseLocalStorageOptions<T> {
  serialize?: (value: T) => string;
  deserialize?: (value: string) => T;
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  options: UseLocalStorageOptions<T> = {},
): [T, (value: T) => void] {
  const { serialize = JSON.stringify, deserialize = JSON.parse } = options;

  // Get initial value from localStorage or use provided initial value
  const getStoredValue = useCallback((): T => {
    try {
      const item = window.localStorage.getItem(key);
      if (item === null) {
        return initialValue;
      }
      return deserialize(item);
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  }, [key, deserialize]);

  // State to store our value
  const [storedValue, setStoredValue] = useState<T>(getStoredValue);

  const saveToStorage = useCallback(
    (value: T) => {
      try {
        window.localStorage.setItem(key, serialize(value));
      } catch (error) {
        console.warn(`Error saving to localStorage key "${key}":`, error);
      }
    },
    [key, serialize],
  );

  const setValue = useCallback(
    (value: T) => {
      setStoredValue(value);
      saveToStorage(value);
    },
    [saveToStorage],
  );

  return [storedValue, setValue];
}
