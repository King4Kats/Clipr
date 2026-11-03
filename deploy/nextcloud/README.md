# Clipr dans un Nextcloud : onglet + connexion unique

Clipr tourne sur sa propre machine (il lui faut un GPU), mais rien n'oblige les
utilisateurs a le savoir. Du point de vue d'un membre de l'association, Clipr
devient une application du cloud comme les autres : une icone dans le menu du
haut, et la connexion avec le compte habituel.

Deux briques, cote Nextcloud, et aucune ligne de code a ecrire :

1. **External sites** (app `external`) : ajoute l'onglet dans le menu, visible
   seulement pour les groupes choisis.
2. **OpenID Connect** (app `oidc`) : le cloud devient le fournisseur d'identite
   de Clipr. C'est lui qui authentifie, et il transmet a Clipr le nom, l'e-mail
   et **les groupes** de la personne.

Consequence pratique, qui est tout l'interet de la manoeuvre : l'administrateur
du cloud gere Clipr **sans jamais ouvrir Clipr**. Ajouter quelqu'un au groupe
`Clipr` lui donne l'onglet et le droit d'entrer ; le retirer du groupe lui
ferme la porte. Les administrateurs du cloud sont automatiquement
administrateurs dans Clipr.

## 1. Le groupe d'acces

```bash
occ group:add Clipr
occ group:adduser Clipr "<identifiant de la personne>"
```

Le nom du groupe est libre : c'est `groupeAcces` dans la configuration de Clipr
(`Clipr` par defaut).

## 2. Le client OIDC

L'app `oidc` doit etre installee et activee. On declare Clipr comme client
confidentiel, avec l'adresse de retour **exacte** et les scopes utiles :

```bash
occ oidc:create "Clipr" "https://<clipr>/api/auth/sso/callback" \
    --allowed_scopes "openid profile email groups"
```

La commande repond un JSON contenant `client_id` et `client_secret`. Ce secret
ne doit aller que dans la configuration de Clipr (variable d'environnement ou
fichier `sso-nextcloud.json` en droits 600) : jamais dans un depot, jamais dans
un journal, jamais dans une conversation.

Deux pieges :

- **l'adresse de retour se compare au caractere pres.** Un `/` en trop, `http`
  au lieu de `https`, ou un autre domaine, et le cloud refuse. C'est pour cela
  que Clipr lit en priorite `SSO_NC_URL_PUBLIQUE` plutot que `PUBLIC_URL`, qui
  sert aussi aux liens des e-mails et peut avoir vieilli ;
- **le scope `groups` est indispensable.** Sans lui, Clipr ne recoit aucun
  groupe : personne n'a acces et personne n'est administrateur.

Les groupes arrivent sous forme d'identifiants de groupe quand le reglage
`group_claim_type` de l'app `oidc` vaut `gid` (c'est le cas par defaut). Clipr
compare sans tenir compte de la casse ni des espaces de bord.

## 3. L'onglet dans le menu

Dans Administration > Sites externes, ajouter un site :

- **Nom** : Clipr
- **Adresse** : `https://<clipr>/`
- **Icone** : [`clipr.svg`](clipr.svg) (une icone de menu Nextcloud est un SVG
  24x24 blanc et monochrome : le logo couleur de l'application y serait
  illisible)
- **Groupes** : le groupe d'acces, plus `admin`

L'onglet pointe la racine de Clipr : une personne non connectee y est renvoyee
vers l'ecran de connexion, ou le bouton du cloud l'attend.

## 4. Verifier sans se connecter

Quatre appels suffisent a prouver que la chaine est en place :

```bash
curl -s https://<clipr>/api/auth/sso
# {"actif":true,...}  → Clipr a bien lu sa configuration

curl -sD- -o /dev/null "https://<clipr>/api/auth/sso/start?retour=%2F" | grep -i location
# 302 vers <cloud>/apps/oidc/authorize?... → verifier que redirect_uri est la bonne

curl -sD- -o /dev/null "<l'adresse authorize ci-dessus>" | grep -iE "^HTTP|^Location"
# 303 vers la page de connexion du cloud → le client et son adresse de retour
# sont acceptes (un client inconnu renverrait une erreur)

curl -sD- -o /dev/null https://<clipr>/api/auth/sso/callback | grep -i location
# 302 vers /login#erreur_sso=... → les retours incomplets sont refuses proprement
```

Le reste (la vraie connexion) se fait en cliquant sur l'onglet depuis un compte
du cloud.
