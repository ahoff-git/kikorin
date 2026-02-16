import { log, logLevels } from "./logging";

/**
 * Generates a random number within the specified range, supporting precision.
 * 
 * - If `decimals` is provided, the result is rounded to that many decimal places.
 * - If `decimals` is not provided, the precision is derived from the decimal places of the `low` and `high` inputs.
 * 
 * @param {number} low - The minimum value (inclusive) of the range.
 * @param {number} high - The maximum value (exclusive) of the range.
 * @param {number | null} [decimals=null] - The number of decimal places to round to. If not provided, precision is derived automatically.
 * @returns {number} - A random number between `low` and `high`, rounded to the specified or derived precision.
 * 
 * @example
 * // Example 1: Whole number output
 * rng(1, 10); // Could return 7
 * 
 * @example
 * // Example 2: Fixed decimal places
 * rng(1.5, 3.5, 2); // Could return 2.78
 * 
 * @example
 * // Example 3: Automatically derived precision
 * rng(0.001, 0.1); // Could return 0.023 (3 decimal places derived)
 */
export function rng(low: number, high: number, decimals: number | null = null): number {
    const lowDecimals = (low.toString().split(".")[1] || "").length;
    const highDecimals = (high.toString().split(".")[1] || "").length;
    const derivedDecimals = Math.max(lowDecimals, highDecimals); // Derive max precision

    const randomValue = Math.random() * (high - low) + low;

    // If decimals is explicitly set, use it; otherwise, use derived precision
    return decimals !== null
        ? parseFloat(randomValue.toFixed(decimals))
        : parseFloat(randomValue.toFixed(derivedDecimals));
}

/**
 * Selects a random item from an array of a specific type.
 *
 * Utilizes the `rng` function to generate a random index within the bounds of the array.
 *
 * @template T - The type of elements in the array.
 * @param {T[]} collection - The array to select a random item from.
 * @returns {T} - A randomly selected item from the array.
 *
 * @throws {Error} Throws an error if the collection is empty.
 *
 * @example
 * // Example 1: Random item from a number array
 * const numbers = [1, 2, 3, 4, 5];
 * const randomNum = randomItem(numbers); // TypeScript infers: number
 *
 * @example
 * // Example 2: Random item from a string array
 * const fruits = ["apple", "banana", "cherry"];
 * const randomFruit = randomItem(fruits); // TypeScript infers: string
 */
export function randomItem<T>(collection: T[]): T {
    if (collection.length === 0) {
        log(logLevels.error, "Cannot select a random item from an empty array.", ['randomItem'], collection);
    }
    return collection[Math.floor(rng(0, collection.length-1))];
}

export function getRndColor(){

    const red = Math.round(Math.random() * (234)+10);
	const green= Math.round(Math.random() * (234)+20);
	const blue= Math.round(Math.random() * (234)+20);
		
	const color ="#"+red.toString(16)+green.toString(16)+blue.toString(16);
	
	return color;
}

export function getColorPair() {
  
    const red = Math.round(Math.random() * (234) + 10);
    const antiRed = Math.abs(red - 234) + 20;
    const green = Math.round(Math.random() * (234) + 20);
    const antiGreen = Math.abs(green - 234) + 20;
    const blue = Math.round(Math.random() * (234) + 20);
    const antiblue = Math.abs(blue - 234) + 20;
  
    const color = "#" + red.toString(16) + green.toString(16) + blue.toString(16);
    const antiColor = "#" + antiRed.toString(16) + antiGreen.toString(16) + antiblue.toString(16);
  
    //console.log(red+" "+green+" "+blue);
    //console.log(antiRed+" "+antiGreen+" "+antiblue);
    return { c1: color, c2: antiColor };
  }

  export function colorFrmRange(c1: string, c2: string, percent: number) {
    percent = percent / 100;
  
    const c1R = parseInt(c1.slice(1, 3), 16);
    const c1G = parseInt(c1.slice(3, 5), 16);
    const c1B = parseInt(c1.slice(5, 7), 16);
  
    const c2R = parseInt(c2.slice(1, 3), 16);
    const c2G = parseInt(c2.slice(3, 5), 16);
    const c2B = parseInt(c2.slice(5, 7), 16);
  
    const rDif = c1R - c2R;
    const gDif = c1G - c2G;
    const bDif = c1B - c2B;
  
    let red = Math.round(c1R - percent * rDif).toString(16);
    let green = Math.round(c1G - percent * gDif).toString(16);
    let blue = Math.round(c1B - percent * bDif).toString(16);
  
    if (red.length < 2) { red = "0" + red; }
    if (green.length < 2) { green = "0" + green; }
    if (blue.length < 2) { blue = "0" + blue; }
  
    const color = "#" + red + green + blue;
  
    return color;
  }

  /**
 * Determines whether a hex color is light or dark and returns a contrasting color (black or white).
 * @param hexColor - The hex color string (e.g., "#FFFFFF" or "FFFFFF").
 * @returns A string representing the contrasting color ("#000000" for black or "#FFFFFF" for white).
 */
export function getContrastingColor(hexColor: string): string {
    // Remove the '#' if present
    const normalizedHex = hexColor.replace(/^#/, "");
  
    // Parse the RGB values
    const r = parseInt(normalizedHex.slice(0, 2), 16);
    const g = parseInt(normalizedHex.slice(2, 4), 16);
    const b = parseInt(normalizedHex.slice(4, 6), 16);
  
    // Calculate the relative luminance (standard formula)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  
    // Return black for light backgrounds, white for dark backgrounds
    return luminance > 0.5 ? "#000000" : "#FFFFFF";
  }
  