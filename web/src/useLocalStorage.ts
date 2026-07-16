import {
  useState,
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

interface UseLocalStorageOptions<T> {
  serialize?: (value: T) => string;
  deserialize?: (value: string) => T;
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  options: UseLocalStorageOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
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
  const valueRef = useRef(storedValue);

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
    (value: SetStateAction<T>) => {
      const nextValue =
        typeof value === "function"
          ? (value as (previousValue: T) => T)(valueRef.current)
          : value;
      valueRef.current = nextValue;
      setStoredValue(nextValue);
      saveToStorage(nextValue);
    },
    [saveToStorage],
  );

  return [storedValue, setValue];
}
