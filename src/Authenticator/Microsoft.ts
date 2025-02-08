/**
 * This code is distributed under the CC-BY-NC 4.0 license:
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Original author: Luuxis
 */

import nodeFetch from 'node-fetch';
import crypto from 'crypto';

// Possible client types (Electron, NW.js, or terminal usage)
export type MicrosoftClientType = 'electron' | 'nwjs' | 'terminal';

// Basic structure for a Minecraft profile, with optional base64 fields
export interface MinecraftSkin {
	id?: string;
	state?: string;
	url?: string;
	variant?: string;
	alias?: string;
	base64?: string; // We add base64 representation after fetching
}

export interface MinecraftProfile {
	id: string;
	name: string;
	skins?: MinecraftSkin[];
	capes?: MinecraftSkin[];
}

// Structure for errors returned by the different steps in authentication
export interface AuthError {
	error: string;
	errorType?: string;
	[key: string]: any;
}

// Main structure for successful authentication
export interface AuthResponse {
	access_token: string;
	client_token: string;
	uuid: string;
	name: string;
	refresh_token: string;
	user_properties: string;
	meta: {
		type: 'Xbox';
		access_token_expires_in: number;
		demo: boolean;
	};
	xboxAccount: {
		xuid: string;
		gamertag: string;
		ageGroup: string;
	};
	profile: {
		skins?: MinecraftSkin[];
		capes?: MinecraftSkin[];
	};
}

// Utility function to fetch and convert an image to base64
async function getBase64(url: string): Promise<string> {
	const response = await nodeFetch(url);
	const buffer = await response.buffer();
	return buffer.toString('base64');
}

export default class Microsoft {
	public client_id: string;
	public type: MicrosoftClientType;

	/**
	 * Creates a Microsoft auth instance.
	 * @param client_id Your Microsoft OAuth client ID (default: '00000000402b5328' if none provided).
	 */
	constructor(client_id: string) {
		if (!client_id) {
			client_id = '00000000402b5328';
		}
		this.client_id = client_id;

		// Determine if we're running under Electron, NW.js, or just in a terminal
		if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
			this.type = 'electron';
		} else if (typeof process !== 'undefined' && process.versions && process.versions.nw) {
			this.type = 'nwjs';
		} else {
			this.type = 'terminal';
		}
	}

	/**
	 * Opens a GUI (Electron or NW.js) or uses terminal approach to fetch an OAuth2 code,
	 * and then retrieves user information from Microsoft if successful.
	 *
	 * @param type The environment to open the OAuth window. Defaults to the auto-detected type.
	 * @param url  The full OAuth2 authorization URL. If not provided, a default is used.
	 * @returns    An object with user data on success, or false if canceled.
	 */
	public async getAuth(type?: MicrosoftClientType, url?: string): Promise<AuthResponse | AuthError | false> {
		const finalType = type || this.type;
		const finalUrl = url ||
			`https://login.live.com/oauth20_authorize.srf?client_id=${this.client_id}&response_type=code&redirect_uri=https://login.live.com/oauth20_desktop.srf&scope=XboxLive.signin%20offline_access&cobrandid=8058f65d-ce06-4c30-9559-473c9275a65d&prompt=select_account`;

		// Dynamically require different GUI modules depending on environment
		let userCode: string | 'cancel';
		switch (finalType) {
			case 'electron':
				userCode = await (require('./GUI/Electron.js'))(finalUrl);
				break;
			case 'nwjs':
				userCode = await (require('./GUI/NW.js'))(finalUrl);
				break;
			case 'terminal':
				userCode = await (require('./GUI/Terminal.js'))(finalUrl);
				break;
			default:
				return false;
		}

		if (userCode === 'cancel') {
			return false;
		}

		// Exchange the code for an OAuth2 token, then retrieve account data
		return this.exchangeCodeForToken(userCode);
	}

	/**
	 * Exchanges an OAuth2 authorization code for an access token, then retrieves account information.
	 * @param code The OAuth2 authorization code returned by Microsoft.
	 * @returns    The authenticated user data or an error object.
	 */
	private async exchangeCodeForToken(code: string): Promise<AuthResponse | AuthError> {
		try {
			const response = await nodeFetch('https://login.live.com/oauth20_token.srf', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: `client_id=${this.client_id}&code=${code}&grant_type=authorization_code&redirect_uri=https://login.live.com/oauth20_desktop.srf`
			});
			const oauth2 = await response.json();

			if (oauth2.error) {
				return { error: oauth2.error, errorType: 'oauth2', ...oauth2 };
			}
			return this.getAccount(oauth2);
		} catch (err: any) {
			return { error: err.message, errorType: 'network' };
		}
	}

	/**
	 * Refreshes the user's session if the token has expired or is about to expire.
	 * Otherwise, simply fetches the user's profile.
	 *
	 * @param acc A previously obtained AuthResponse object.
	 * @returns   Updated AuthResponse (with new token if needed) or an error object.
	 */
	public async refresh(acc: AuthResponse | any): Promise<AuthResponse | AuthError> {
		const timeStamp = Math.floor(Date.now() / 1000);

		// If the token is still valid for at least 2 more hours, just re-fetch the profile
		if (timeStamp < (acc?.meta?.access_token_expires_in - 7200)) {
			const updatedProfile = await this.getProfile({ access_token: acc.access_token });
			if ('error' in updatedProfile) {
				// If there's an error, return it directly
				return updatedProfile;
			}
			acc.profile = {
				skins: updatedProfile.skins,
				capes: updatedProfile.capes
			};
			return acc;
		}

		// Otherwise, refresh the token
		try {
			const response = await nodeFetch('https://login.live.com/oauth20_token.srf', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: `grant_type=refresh_token&client_id=${this.client_id}&refresh_token=${acc.refresh_token}`
			});
			const oauth2 = await response.json();

			if (oauth2.error) {
				return { error: oauth2.error, errorType: 'oauth2', ...oauth2 };
			}
			// Retrieve account data with the new tokens
			return this.getAccount(oauth2);
		} catch (err: any) {
			return { error: err.message, errorType: 'network' };
		}
	}

	/**
	 * Retrieves and assembles the full account details (Xbox Live, XSTS, Minecraft).
	 * @param oauth2 The token object returned by the Microsoft OAuth endpoint.
	 * @returns      A fully populated AuthResponse object or an error.
	 */
	private async getAccount(oauth2: any): Promise<AuthResponse | AuthError> {
		// 1. Authenticate with Xbox Live
		const xblResponse = await this.fetchJSON('https://user.auth.xboxlive.com/user/authenticate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({
				Properties: {
					AuthMethod: 'RPS',
					SiteName: 'user.auth.xboxlive.com',
					RpsTicket: `d=${oauth2.access_token}`
				},
				RelyingParty: 'http://auth.xboxlive.com',
				TokenType: 'JWT'
			})
		});
		if (xblResponse.error) {
			return { ...xblResponse, errorType: 'xbl' };
		}

		// 2. Authorize with XSTS for Minecraft services
		const xstsResponse = await this.fetchJSON('https://xsts.auth.xboxlive.com/xsts/authorize', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				Properties: {
					SandboxId: 'RETAIL',
					UserTokens: [xblResponse.Token]
				},
				RelyingParty: 'rp://api.minecraftservices.com/',
				TokenType: 'JWT'
			})
		});
		if (xstsResponse.error) {
			return { ...xstsResponse, errorType: 'xsts' };
		}

		// 3. Authorize for the standard Xbox Live realm (useful for xuid/gamertag)
		const xboxAccount = await this.fetchJSON('https://xsts.auth.xboxlive.com/xsts/authorize', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				Properties: {
					SandboxId: 'RETAIL',
					UserTokens: [xblResponse.Token]
				},
				RelyingParty: 'http://xboxlive.com',
				TokenType: 'JWT'
			})
		});
		if (xboxAccount.error) {
			return { ...xboxAccount, errorType: 'xboxAccount' };
		}

		// 4. Get a launcher token from Minecraft services
		const launchResponse = await this.fetchJSON('https://api.minecraftservices.com/launcher/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				xtoken: `XBL3.0 x=${xblResponse.DisplayClaims.xui[0].uhs};${xstsResponse.Token}`,
				platform: 'PC_LAUNCHER'
			})
		});
		if (launchResponse.error) {
			return { ...launchResponse, errorType: 'launch' };
		}

		// 5. Login with Xbox token to get a Minecraft token
		const mcLogin = await this.fetchJSON('https://api.minecraftservices.com/authentication/login_with_xbox', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				identityToken: `XBL3.0 x=${xblResponse.DisplayClaims.xui[0].uhs};${xstsResponse.Token}`
			})
		});
		if (mcLogin.error) {
			return { ...mcLogin, errorType: 'mcLogin' };
		}

		// 6. Check if the account has purchased Minecraft
		const hasGame = await this.fetchJSON('https://api.minecraftservices.com/entitlements/mcstore', {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${mcLogin.access_token}`
			}
		});
		if (!hasGame.items?.find((i: any) => i.name === 'product_minecraft' || i.name === 'game_minecraft')) {
			return {
				error: "You don't own the game",
				errorType: 'game'
			};
		}

		// 7. Fetch the user profile (skins, capes, etc.)
		const profile = await this.getProfile(mcLogin);
		if ('error' in profile) {
			return { ...profile, errorType: 'profile' };
		}

		// Build and return the final AuthResponse object
		return {
			access_token: mcLogin.access_token,
			client_token: crypto.randomBytes(16).toString('hex'),
			uuid: profile.id,
			name: profile.name,
			refresh_token: oauth2.refresh_token,
			user_properties: '{}',
			meta: {
				type: 'Xbox',
				access_token_expires_in: mcLogin.expires_in + Math.floor(Date.now() / 1000),
				demo: false // If there's an error retrieving the profile, you can set this to true
			},
			xboxAccount: {
				xuid: xboxAccount.DisplayClaims.xui[0].xid,
				gamertag: xboxAccount.DisplayClaims.xui[0].gtg,
				ageGroup: xboxAccount.DisplayClaims.xui[0].agg
			},
			profile: {
				skins: profile.skins,
				capes: profile.capes
			}
		};
	}

	/**
	 * Fetches the Minecraft profile (including skins and capes) for a given access token,
	 * then converts each skin/cape URL to base64.
	 *
	 * @param mcLogin An object containing `access_token` to call the Minecraft profile API.
	 * @returns The user's Minecraft profile or an error object.
	 */
	public async getProfile(mcLogin: { access_token: string }): Promise<MinecraftProfile | AuthError> {
		try {
			const response = await nodeFetch('https://api.minecraftservices.com/minecraft/profile', {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${mcLogin.access_token}`
				}
			});
			const profile = await response.json();

			if (profile.error) {
				return { error: profile.error };
			}

			// Convert each skin and cape to base64
			if (Array.isArray(profile.skins)) {
				for (const skin of profile.skins) {
					if (skin.url) {
						skin.base64 = `data:image/png;base64,${await getBase64(skin.url)}`;
					}
				}
			}
			if (Array.isArray(profile.capes)) {
				for (const cape of profile.capes) {
					if (cape.url) {
						cape.base64 = `data:image/png;base64,${await getBase64(cape.url)}`;
					}
				}
			}

			return {
				id: profile.id,
				name: profile.name,
				skins: profile.skins || [],
				capes: profile.capes || []
			};
		} catch (err: any) {
			return { error: err.message };
		}
	}

	/**
	 * A helper method to perform fetch and parse JSON.
	 * @param url     The endpoint URL.
	 * @param options fetch options (method, headers, body, etc.).
	 * @returns       The parsed JSON or an object with an error field if something goes wrong.
	 */
	private async fetchJSON(url: string, options: Record<string, any>): Promise<any> {
		try {
			const response = await nodeFetch(url, options);
			return response.json();
		} catch (err: any) {
			return { error: err.message };
		}
	}
}
