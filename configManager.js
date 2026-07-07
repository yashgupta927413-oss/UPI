/**
 * configManager.js
 * Utility to read and write backend configuration variables directly to the .env file.
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');

/**
 * Reads and parses the .env file.
 * @returns {object} Map of key-value config pairs.
 */
function readConfig() {
  const config = {};
  if (!fs.existsSync(envPath)) {
    return config;
  }

  try {
    const data = fs.readFileSync(envPath, 'utf8');
    const lines = data.split('\n');
    
    lines.forEach((line) => {
      const trimmed = line.trim();
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) return;

      const delimiterIdx = trimmed.indexOf('=');
      if (delimiterIdx > 0) {
        const key = trimmed.slice(0, delimiterIdx).trim();
        const value = trimmed.slice(delimiterIdx + 1).trim();
        // Remove surrounding quotes if present
        const cleanValue = value.replace(/^['"]|['"]$/g, '');
        config[key] = cleanValue;
      }
    });
  } catch (error) {
    console.error('[Config Manager] Error reading .env file:', error);
  }

  return config;
}

/**
 * Writes updated configurations back to the .env file.
 * @param {object} newConfig Map of key-value pairs to write/update.
 * @returns {boolean} True if write succeeded.
 */
function writeConfig(newConfig) {
  try {
    const currentConfig = readConfig();
    
    // Merge new configs into current configs
    const mergedConfig = { ...currentConfig, ...newConfig };

    // Format into standard .env string
    const envLines = [];
    Object.keys(mergedConfig).forEach((key) => {
      const val = mergedConfig[key];
      // Keep keys tidy and properly handle space containing values by quoting
      const formattedVal = String(val).includes(' ') ? `"${val}"` : val;
      envLines.push(`${key}=${formattedVal}`);
    });

    fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf8');
    return true;
  } catch (error) {
    console.error('[Config Manager] Error writing to .env file:', error);
    return false;
  }
}

module.exports = {
  readConfig,
  writeConfig
};
