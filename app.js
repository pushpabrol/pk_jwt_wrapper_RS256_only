// Import required Node.js modules and libraries
const express = require('express');
const { SignJWT, importPKCS8, jwtVerify, createRemoteJWKSet } = require('jose');  // JSON Object Signing and Encryption (JOSE) library
const axios = require('axios'); // HTTP client for making requests
const uuid = require('uuid'); // Universally Unique Identifier (UUID) generator
const dotenv = require('dotenv'); // Load environment variables from a .env file
const qs = require('querystring'); // Query string parsing and formatting
const decode = (input) => Buffer.from(input, 'base64');
const crypto = require('crypto');


const relyingPartyJWKS = require('./spkis/relyingPartyJWKS.json');

dotenv.config(); // Load environment variables from the .env file
process.env.RP_CLIENT_ASSERTION_SIGNING_ALG = process.env.RP_CLIENT_ASSERTION_SIGNING_ALG || "RS256";
const LOG = process.env.DEBUG === "true" ? console.log.bind(console) : function () { };

const app = express(); // Create an Express application
const port = 3000; // Define the port for the server to listen on

// Middleware to parse JSON request bodies
app.use(express.json());

// Middleware to parse URL-encoded request bodies
app.use(express.urlencoded({ extended: true }));

// Create a route for the /token endpoint
app.post('/token', async (req, res) => {
    const context = process.env;
    LOG(req.body);

    const { client_id, code, redirect_uri, code_verifier, client_secret } = req.body;

    if (!client_id) {
        return res.status(400).send('Missing client_id');
    }

    if (client_secret && client_secret !== context.A0_CLIENT_SECRET) return res.status(400).send('client auth failed by auth0!');

    if (context.RP_ID === client_id) {
        try {
            const client_assertion = await generatePrivateKeyJWTForClientAssertion(context);
            LOG(client_assertion);

            const data = {
                grant_type: 'authorization_code',
                client_id: context.RP_ID,
                client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                client_assertion,
                code,
                redirect_uri,
                ...(code_verifier && { code_verifier })
            };

            const options = {
                method: 'POST',
                url: `https://${context.IDP_DOMAIN}${context.IDP_TOKEN_ENDPOINT}`,
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                data: qs.stringify(data),
            };

            const response = await axios.request(options);
            LOG(response.data);

            const { id_token } = response.data;

            const header = JSON.parse(decode(id_token.split('.')[0]));

            // If the token is signed with RS256, pass it as is
            if (header.alg === 'RS256') {
                return res.status(200).send(response.data);
            }

            // Handle tokens signed with other algorithms
            return res.status(500).send(`Unsupported signing algorithm: ${header.alg}`);


        } catch (error) {
            if (error.response) {
                return res.status(error.response.status).send(error.response.data);
            } else {
                console.error('Error:', error.message);
                return res.status(500).send(error.message);
            }
        }
    } else {
        return res.status(401).send('Invalid request, client_id is incorrect!');
    }
});


const jwksETag = crypto.createHash('sha256').update(JSON.stringify(relyingPartyJWKS)).digest('base64');

app.get('/.well-known/keys', async (req, res) => {
    // Check if the client's cached version matches the current ETag
    if (req.headers['if-none-match'] === jwksETag) {
        // If the ETag matches, send a 304 Not Modified response
        return res.status(304).send();
    }

    res.set({
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
        'Content-Type': 'application/json',
        'ETag': jwksETag, // Provide ETag for cache validation
    });
    res.json(relyingPartyJWKS);
});
// Start the Express server and listen on the specified port
app.listen(port, () => {
    LOG(`Server is listening at http://localhost:${port}`);
});



// Function to load the RS256 private key
async function loadPrivateKeyForClientAssertion(context) {
    try {
        var privateKey = context[`RP_PRIVATE_KEY_${context.RP_CLIENT_ASSERTION_SIGNING_ALG}`].replace(/\n/g, "\r\n");
        var key = await importPKCS8(privateKey, context.RP_CLIENT_ASSERTION_SIGNING_ALG);
        return key;
    } catch (e) {
        LOG(e);
        return e;
    }
}



// Function to generate a client_assertion (JWT) for client authentication
async function generatePrivateKeyJWTForClientAssertion(context) {
    try {
        const key = await loadPrivateKeyForClientAssertion(context);
        LOG(key);
        const jwt = await new SignJWT({})
            .setProtectedHeader({ alg: context.RP_CLIENT_ASSERTION_SIGNING_ALG, kid: context[`RP_KID_${context.RP_CLIENT_ASSERTION_SIGNING_ALG}`] })
            .setIssuedAt()
            .setIssuer(context.RP_ID)
            .setSubject(context.RP_ID)
            .setAudience([`https://${context.IDP_DOMAIN}/`, `https://${context.IDP_DOMAIN}/token`])
            .setExpirationTime('2m') // Expiration time
            .setJti(uuid.v4())
            .sign(key);
        //LOG(jwt);
        return jwt;
    } catch (error) {
        LOG(error);
        return error;
    }
}







