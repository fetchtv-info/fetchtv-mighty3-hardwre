package main

import "strings"

// City is one feed in xmltv.net's Australian list
// (https://www.xmltv.net/free-epg-xml-links-for-australia/). Keeping the table
// in the daemon - rather than fetching the index page - means the menu works
// offline and the URLs can be audited in one place.
type City struct {
	Name string
	URL  string
}

const feedBase = "https://xmltv.net/xml_files/"

func city(name, file string) City { return City{Name: name, URL: feedBase + file + ".xml"} }

var guideCities = []City{
	city("Adelaide", "Adelaide"),
	city("Albany", "Albany"),
	city("Albury / Wodonga", "Albury_Wodonga"),
	city("Ballarat", "Ballarat"),
	city("Bendigo", "Bendigo"),
	city("Brisbane", "Brisbane"),
	city("Broken Hill", "Broken_Hill"),
	city("Bunbury", "Bunbury"),
	city("Cairns", "Cairns"),
	city("Canberra", "Canberra"),
	city("Central Coast NSW", "Central_Coast"),
	city("Coffs Harbour", "Coffs_Harbour"),
	city("Darwin", "Darwin"),
	city("Geelong", "Geelong"),
	city("Gippsland", "Gippsland"),
	city("Gold Coast", "Goldcoast"),
	city("Griffith", "Griffith"),
	city("Hobart", "Hobart"),
	city("Jurien Bay", "Jurien_Bay"),
	city("Launceston", "Launceston"),
	city("Lismore", "Lismore"),
	city("Mackay", "Mackay"),
	city("Mandurah", "Mandurah"),
	city("Melbourne", "Melbourne"),
	city("Mildura/Sunraysia", "Mildura_Sunraysia"),
	city("Newcastle", "Newcastle"),
	city("NSW Regional", "Remote_Central"),
	city("NT Regional", "NT_Regional"),
	city("Orange", "Orange_Dubbo"),
	city("Perth", "Perth"),
	city("Port Augusta", "Port_Augusta"),
	city("QLD Regional", "QLD_Regional"),
	city("Renmark", "Renmark"),
	city("Riverland", "Riverland"),
	city("Rockhampton", "Rockhampton"),
	city("S.A. Regional", "SA_Regional"),
	city("Shepparton", "Shepparton"),
	city("South Coast NSW", "South_Coast"),
	city("South East S.A.", "South_East_SA"),
	city("Spencer Gulf", "Spencer_Gulf"),
	city("Sunshine Coast", "Sunshine_Coast"),
	city("Sydney", "Sydney"),
	city("Tamworth", "Tamworth"),
	city("Taree / Port Macquarie", "Taree_Port_Macquarie"),
	city("Tasmania Regional", "TAS_Regional"),
	city("Toowoomba", "Toowoomba"),
	city("Townsville", "Townsville"),
	city("W.A. Regional", "WA_Regional"),
	city("Wagga Wagga", "Wagga_Wagga"),
	city("Wide Bay", "Wide_Bay"),
	city("Wollongong", "Wollongong"),
}

// cityByName matches case-insensitively and ignores spare spaces, so a typo in
// the config file does not need a reboot to diagnose.
func cityByName(name string) (City, bool) {
	want := strings.Join(strings.Fields(strings.ToLower(name)), " ")
	for _, c := range guideCities {
		if strings.Join(strings.Fields(strings.ToLower(c.Name)), " ") == want {
			return c, true
		}
	}
	return City{}, false
}

func cityNames() []string {
	out := make([]string, 0, len(guideCities))
	for _, c := range guideCities {
		out = append(out, c.Name)
	}
	return out
}
