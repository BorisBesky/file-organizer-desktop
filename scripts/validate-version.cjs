#!/usr/bin/env node

/**
 * Validates that all version files are in sync
 * Used as a pre-commit hook or CI check
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

function validateVersion() {
  try {
    // Read package.json version (source of truth)
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const expectedVersion = packageJson.version;

    if (!expectedVersion) {
      console.error('❌ No version found in package.json');
      process.exit(1);
    }

    console.log(`📦 Expected version: ${expectedVersion}`);

    let hasError = false;

    // Check Cargo.toml
    const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    const cargoVersionMatch = cargoToml.match(/^version = "(.+)"$/m);
    
    if (!cargoVersionMatch) {
      console.error('❌ Could not find version field in Cargo.toml');
      hasError = true;
    } else {
      const cargoVersion = cargoVersionMatch[1];
      if (cargoVersion !== expectedVersion) {
        console.error(`❌ Cargo.toml version mismatch: expected ${expectedVersion}, found ${cargoVersion}`);
        hasError = true;
      } else {
        console.log(`✅ Cargo.toml version matches: ${cargoVersion}`);
      }
    }

    // Check tauri.conf.json
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    
    if (!tauriConf.package || !tauriConf.package.version) {
      console.error('❌ No package.version field in tauri.conf.json');
      hasError = true;
    } else {
      const tauriVersion = tauriConf.package.version;
      if (tauriVersion !== expectedVersion) {
        console.error(`❌ tauri.conf.json version mismatch: expected ${expectedVersion}, found ${tauriVersion}`);
        hasError = true;
      } else {
        console.log(`✅ tauri.conf.json version matches: ${tauriVersion}`);
      }
    }

    if (hasError) {
      console.error('\n❌ Version validation failed!');
      console.error('Run "npm run version:sync" to fix version inconsistencies.');
      process.exit(1);
    }

    console.log('\n✨ All versions are in sync!');
  } catch (error) {
    console.error('❌ Error validating version:', error.message);
    process.exit(1);
  }
}

validateVersion();
