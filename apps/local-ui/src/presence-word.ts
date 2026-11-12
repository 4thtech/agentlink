// One word for the owner-presence sensor, used by every screen that asks for it (11 §5: Touch ID on
// a Mac, Windows Hello on Windows, "your passkey" elsewhere). Copy that names the sensor calls this,
// so the same session never mixes "Touch ID", "your passkey" and "passkey".
import { detectPlatform } from './pages/first-run/passkey.js';
import { SENSOR } from './pages/first-run/strings.js';

/** The sensor's name in running text ("Touch ID", "Windows Hello", "your passkey"). */
export const sensorWord = (): string => SENSOR[detectPlatform()];

/** The same word at the start of a sentence ("Your passkey wasn't used"). */
export const sensorSentence = (): string => {
  const w = sensorWord();
  return w.charAt(0).toUpperCase() + w.slice(1);
};
