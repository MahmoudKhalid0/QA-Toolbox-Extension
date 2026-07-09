import supabaseConfig from './supabase-config.js';

const { supabaseUrl, supabaseKey } = supabaseConfig;

/**
 * Upload a file to Supabase Storage
 */
export async function uploadFileToSupabase(blob, fileName) {
    const bucket = 'captures'; // Ensure you create this bucket in Supabase and make it public
    const url = `${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`;
    console.log("Supabase Upload Attempt:", { url, fileName, type: blob.type });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${supabaseKey}`,
                'apikey': supabaseKey,
                'Content-Type': blob.type
            },
            body: blob
        });

        if (!response.ok) {
            const error = await response.json();
            console.error("Supabase Storage Error Response:", error);
            throw new Error(`Supabase Storage Error: ${error.message || response.statusText}`);
        }

        // Construct the public URL
        const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
        console.log("Supabase Upload Success. Public URL:", publicUrl);

        return {
            name: fileName,
            url: publicUrl,
            size: blob.size
        };
    } catch (err) {
        console.error("Supabase Fetch Catch:", err);
        throw err;
    }
}

/**
 * Save metadata to Supabase 'history' table
 */
export async function saveToHistory(data) {
    const url = `${supabaseUrl}/rest/v1/history`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify(data)
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Supabase DB Error: ${error.message || response.statusText}`);
    }

    return await response.json();
}

/**
 * Fetch items from Supabase 'history' table
 */
export async function getHistoryFromSupabase() {
    const url = `${supabaseUrl}/rest/v1/history?select=*&order=timestamp.desc`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'apikey': supabaseKey,
            'Content-Type': 'application/json'
        }
    });

    return await response.json();
}

/**
 * Delete a file and its metadata
 */
export async function deleteFromSupabase(fileName, id) {
    const bucket = 'captures';

    // 1. Delete Record from Database
    const dbUrl = `${supabaseUrl}/rest/v1/history?id=eq.${id}`;
    await fetch(dbUrl, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'apikey': supabaseKey
        }
    });

    // 2. Delete File from Storage
    const storageUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`;
    await fetch(storageUrl, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'apikey': supabaseKey
        }
    });

    return true;
}
