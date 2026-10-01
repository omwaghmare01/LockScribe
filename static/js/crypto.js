/**
 * LockScribe Client-Side Encryption Engine (Web Crypto API)
 * Zero-Knowledge standard: Raw text server par kabhi send nahi hota.
 */

const CryptoEngine = {
    salt: new TextEncoder().encode("LockScribe_Deterministic_Vault_Salt_v1"),

    // Passphrase se AES-GCM Key banana (100,000 iterations PBKDF2)
    async deriveVaultKey(passphrase) {
        const enc = new TextEncoder();
        const baseKey = await crypto.subtle.importKey(
            "raw",
            enc.encode(passphrase),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );

        return await crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: this.salt,
                iterations: 100000,
                hash: "SHA-256"
            },
            baseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    },

    // Plain text to Base64 Ciphertext (with random 12-byte IV)
    async encrypt(text, key) {
        if (!text) return "";
        const enc = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(12));

        const encryptedBuffer = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            enc.encode(text)
        );

        // Bundle IV + Encrypted Data into Base64
        const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(encryptedBuffer), iv.length);

        let binary = '';
        const bytes = new Uint8Array(combined);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },

    // Base64 Ciphertext to Decrypted Plain Text
    async decrypt(cipherBase64, key) {
        if (!cipherBase64) return "";
        try {
            const binary = atob(cipherBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }

            const iv = bytes.slice(0, 12);
            const data = bytes.slice(12);

            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: iv },
                key,
                data
            );

            return new TextDecoder().decode(decryptedBuffer);
        } catch (err) {
            console.warn("Decryption error:", err);
            return "[Encrypted Payload - Key Required]";
        }
    }
};