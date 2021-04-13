var highlightLock = false;
$.fn.animateHighlight = function(highlightColor, duration) {
    var highlightBg = highlightColor || "#FFFF9C";
    var animateMs = duration || 1500;
    var originalBg = this.css("backgroundColor");
    if (!highlightLock) {
        highlightLock = true;
        this.stop().css("background-color", highlightBg).animate({backgroundColor: originalBg},
                animateMs, 'swing', () => { highlightLock = false; });
    }
};

var platoonMinimums = {
    't01D': [1, 2, 3, 4, 5, 6, 7],
    't02D': [1, 2, 3, 4, 5, 6, 7],
    't03D': [6, 6, 6, 7, 7, 7, 7],
    't04D': [7, 7, 7, 7, 7, 7, 7]
};

function runMap(unitDefs, prosters, battle, power) {
    var mkslug = str => str.replace(/[^a-z0-9\-]/gi, '_');

    var platoons = battle.platoons;
    var strikes  = battle.def.strikes;
    var side     = battle.territory;
    var prefix   = "";
    var mins     = platoonMinimums[side];

    switch (side) {
        case "t02D":
            prefix = "hoth_empire_";
            break;
        case "t03D":
            prefix = "geonosis_separatist_";
            break;
        case "t04D":
            prefix = "geonosis_republic_";
            break;
    }

    $('#battle').show();
    $('.map').hide();
    $('.' + side).show();

    Object.entries(battle.def.conflicts).forEach(cfdef => {
        var id = side + '_' + cfdef[0].slice(prefix.length) + '_stars';
        var sect = battle.sectors.find(s => s.name === cfdef[0]);
        if (sect !== undefined) {
            var stars = "\u2B50".repeat(cfdef[1].stars.filter(s => s <= sect.points).length);
            $('#' + id).text(stars);
        }
    });

    battle.platoons.forEach(p => {
        p.platoons.sort((a, b) => a.name.localeCompare(b.name));
        p.platoons.forEach(q => {
            q.squads.sort((a, b) => a.name.localeCompare(b.name));
        });
    });

    var def = () => {return { 'need': 0, 'have': 0};};

    var guild = {};
    var rosters = [];
    var guildCount = 0;

    // Check platoon requirements per phase to identify stress points
    var perPhase = [1,2,3,4,5,6].map(phase => {
        var sectors = platoons.filter(p => p.name.startsWith(prefix + "phase0" + phase));
        var sector = {};
        sectors.forEach(s => s.platoons.forEach(p => p.squads.forEach(s => s.units.forEach(m => {
            var id = m.split(':')[0];
            if (sector[id] === undefined) { sector[id] = def(); }
            sector[id].need++;
        }))));
        return sector;
    });


    const rarities = [
        'ONE_STAR', 'TWO_STAR', 'THREE_STAR', 'FOUR_STAR', 'FIVE_STAR', 'SIX_STAR', 'SEVEN_STAR'
    ];
    const tiers = [
        'TIER_01', 'TIER_02', 'TIER_03', 'TIER_04', 'TIER_05', 'TIER_06',
        'TIER_07', 'TIER_08', 'TIER_09', 'TIER_10', 'TIER_11', 'TIER_12',
        'TIER_13'
    ];

    const gearPowerSum = (level, count) => {
        var result = 0;
        for (var i = 1; i < level; i++) {
            result += power.tables.gearAtTierPower[tiers[i - 1]] * 6;
        }
        result += count * power.tables.gearAtTierPower[tiers[level - 1]];
        return result;
    }

    const modPower = (mod) => {
        const idx = mod.rarity + ':' + mod.level + ':' + mod.tier + ':' + mod.slot;
        return power.tables.modPower[idx];
    }

    const unitPower = unit => {
        var p = {
            skills: 1.5 * unit.skills.reduce((acc, skill) => power.skills[skill.id][skill.level + 1] + acc, 0),
            level: 1.5 * power.tables.unitLevelPower[unit.level - 1],
            stars: 1.5 * power.tables.unitRarityPower[rarities[unit.rarity - 1]],
            gear: 1.5 * gearPowerSum(unit.gearLevel, unit.equipped.length),
            mods: 1.5 * unit.mods.reduce((acc, mod) => acc + modPower(mod), 0),
        };
        p.total = Math.round(p.skills + p.level + p.stars + p.gear + p.mods);
        return p;
    };

    // How many guild members can complete this mission?
    var completable = strike => {
        var matches = 0;

        try {
            var requires = strikes[strike.name].mission.requires;

            var musts = {};
            requires.mandatoryUnits.forEach(mu => {
                musts[mu.id] = mu.slot;
            });

            rosters.forEach(roster => {
                var matcher = {'MATCHANY': 'some', 'MATCHALL': 'every'}[requires.matchType];

                // basic checks
                var units = roster.units.filter(u =>
                    u.gearLevel >= requires.minimumTier &&
                    u.level >= requires.minimumLevel &&
                    // unitPower(u).total >= requires.minimumPower &&
                    (requires.minimumRarity == 8 || u.rarity >= requires.minimumRarity));

                // category tags
                units = units.filter(u => {
                    var uid = u.id.split(':')[0];
                    var def = unitDefs[uid];
                    if (musts[uid] !== undefined) return true;
                    return def !== undefined
                        && requires.categories[matcher](c => def.tags.includes(c))
                        !requires.excludeCategories[matcher](c => def.tags.incldues(c));
                });

                // TODO: filter capital ship out separately for fleet

                if (requires.minimumPower > 0) {
                    units = units.filter(u => unitPower(u).total >= requires.minimumPower);
                }

                // check for mandatory units and minimum size
                if (units.length >= requires.minimumUnits
                    && requires.mandatoryUnits.every(d => units.some(u => u.id.startsWith(d.id + ':'))))
                    matches++;
            });
        } catch (e) {
            // console.log(strike.name, e);
            matches = guildCount;
        }

        return Math.max(strike.players, matches);
    };

    var planner = phase => {
        if (phase == planner.lastPhase) return;
        planner.lastPhase = phase;

        // Sectors for this phase
        var sectors = platoons.filter(p => p.name.startsWith(prefix + "phase0" + phase));

        // compute the guild's stock for all toons
        var stock = {}, consumed = {};
        Object.entries(guild).forEach(entry => {
            stock[entry[0]] = entry[1].filter(n => n >= mins[phase]).length;
            consumed[entry[0]] = 0;
        });

        // Compute used toons per sector/platoon
        var used = sectors.map(sector => sector.platoons.map(platoon => {
            var toons = {};
            platoon.squads.forEach(squad => squad.units.forEach(toon => {
                var id = toon.split(':')[0];
                if (toons[id] === undefined) { toons[id] = 0; }
                toons[id]++;
                if (stock[id] === undefined) { stock[id] = 0; }
            }));
            return toons;
        }));

        // each platoon is either clear, blocked, or impossible
        var state = used.map(_ => [ 'clear', 'clear', 'clear', 'clear', 'clear', 'clear' ]);
        // selection state
        var choice = used.map(_ => [ '', '', '', '', '', '' ]);

        var spans = [];

        var clearConsumed = () => {
            Object.entries(consumed).forEach(e => consumed[e[0]] = 0);
        };

        var updateConsumed = (si, pi) => {
            if (choice[si][pi] !== 'fill' || state[si][pi] !== 'clear') return;
            Object.entries(used[si][pi]).forEach(e => {
                consumed[e[0]] += e[1];
            });
        };

        var toggleChoice = (si, pi) => evt => {
            if (choice[si][pi] === 'skip' && state[si][pi] === 'clear') {
                choice[si][pi] = 'fill';
                computeState();
            } else if (choice[si][pi] === 'fill' && state[si][pi] !== 'impossible') {
                choice[si][pi] = 'skip';
                computeState();
            }
        };

        $('.planner').empty();
        used.forEach((sector, si) => {
            var sdiv = $('<div>').appendTo('.planner');
            spans.push(sector.map((plat, pi) => $('<span>').appendTo(sdiv).click(toggleChoice(si, pi)) ));
        });

        // Update platoon states
        var computeState = () => {
            clearConsumed();
            used.forEach((sector, si) => {
                sector.forEach((plat, pi) => {
                    var e = Object.entries(plat);
                    if (e.some(entry => stock[entry[0]] < entry[1])) {
                        state[si][pi] = 'impossible';
                    } else if (e.some(entry => stock[entry[0]] - consumed[entry[0]] < entry[1])) {
                        state[si][pi] = 'block';
                    } else {
                        state[si][pi] = 'clear';
                    }

                    // auto-fill empty choices
                    if (choice[si][pi] === '') {
                        if (state[si][pi] === 'clear') {
                            choice[si][pi] = 'fill';
                        } else {
                            choice[si][pi] = 'skip';
                        }
                    }

                    updateConsumed(si, pi);

                    spans[si][pi].attr('class', state[si][pi] + ' ' + choice[si][pi]);
                });
            });
        };
        computeState();

        var fillers = [':one:', ':two:', ':three:', ':four:', ':five:', ':six:'];
        var letters = [':regional_indicator_a:', ':regional_indicator_b:', ':regional_indicator_c:'];
        var nogood = ':no_entry_sign:';

        var message = '';
        used.forEach((sector, si) => {
            message = message + letters[si] + ' ';
            sector.forEach((plat, pi) => {
                if (state[si][pi] === 'clear' && choice[si][pi] === 'fill') {
                    message = message + fillers[pi];
                } else {
                    message = message + nogood;
                }
            });
            message = message + '\n';
        });
        planner.message = message;
    };
    planner.lastPhase = -1;

    // plain old javascript gets cumbersome
    var guildGP = { "UNITS": 0, "SHIPS": 0 };

    var runProjections = (pros, usedGP) => {
        var up = pros.filter(p => p.unit === 'UNITS');
        var gp = guildGP['UNITS'] - usedGP['UNITS'];
        var spent = 0;
        up.forEach(p => p.deploy = 0);

        $('#project-UNITS').empty();
        while (true) {
            var min = { sector: undefined, cost: Infinity };
            up.forEach(sector => {
                var cost = sector.stars.map(s => s - sector.score).filter(s => s > 0);
                if (cost.length > 0 && min.cost > cost[0]) {
                    min = { sector: sector, cost: cost[0] }
                }
            });
            if (min.cost === Infinity) break;
            spent += min.cost;
            min.sector.score += min.cost;
            if (spent <= gp) min.sector.deploy += min.cost;
            var stars = up.map(sector => sector.stars.filter(s => s <= sector.score).length).join('/');
            var madeIt = spent <= gp ? 'affordable' : 'unaffordable';
            $('<li class="' + madeIt + '">' + stars + ' - ' + spent.toLocaleString() + ' GP</li>').appendTo($('#project-UNITS'));
        }
        var plan = up.map(sector => sector.deploy.toLocaleString() + ' GP to ' + sector.name).join(' and ');
        $('#deployplan-UNITS').text(plan);
    };

    var stats = phase => {
        $('#stats').empty();
        var letters = ['A', 'B', 'C', 'D', 'E'];
        var deployedGP = { "UNITS": 0, "SHIPS": 0 };
        var deployedDDs = { "UNITS": [], "SHIPS": [] };
        battle["sectors"]
            // .filter(s => s.name.startsWith(prefix + "phase0" + phase))
            .filter(s => s.status ==="ZONE_OPEN")
            .forEach(sector => {
                var div = $('<div></div>').appendTo('#stats');
                var defn = battle.def.conflicts[sector.name];
                $('<h5>' + defn.name + '</h5>').appendTo(div);
                var dl = $('<dl></dl>').appendTo(div);
                $('<dt>Points</dt><dd>' + sector["points"].toLocaleString() + '</dd>').appendTo(dl);
                defn.stars.forEach((s, i) => {
                    var need = s - sector["points"];
                    if (need > 0) {
                        var dt = "<dt>To " + (i+1) + "-star</dt>";
                        var dd = "<dd>" + need.toLocaleString() + '</dd>';
                        $(dt + dd).appendTo(dl);
                    }
                });
                $('<dt>Platoons</dt><dd>' + sector["platoonPoints"].toLocaleString() + '</dd>').appendTo(dl);
                var totalDamage = 0;
                sector['strikes'].forEach(strike => {
                    var canDo = completable(strike);
                    $('<h5>Combat Mission</h5>').appendTo(div);
                    var ul = $('<ul></ul>').appendTo(div);
                    $('<li>' + strike['players'] + '/' + canDo + ' complete</li>').appendTo(ul);
                    $('<li>' + strike['points'].toLocaleString()  + ' points</li>').appendTo(ul);
                    var avg = strike['players'] > 0 ? Math.floor(strike['points'] / strike['players']) : 0;
                    $('<li>' + avg.toLocaleString() + ' average</li>').appendTo(ul);
                    $('<li>' + (avg*(canDo-strike.players)).toLocaleString() + ' expected</li>').appendTo(ul);
                    totalDamage += strike['points'];
                });
                var deployed = sector['points'] - sector['platoonPoints'] - totalDamage;
                $('<dt>Deployed</dt><dd>' + deployed.toLocaleString() + '</dd>').appendTo(dl);
                var unit = battle.def.conflicts[sector.name].combatType;
                deployedGP[unit] += deployed;
                $('<dt>Undeployed</dt>').appendTo(dl);
                deployedDDs[unit].push($('<dd></dd>').appendTo(dl));
            });
        ["UNITS", "SHIPS"].forEach(unit => {
            deployedDDs[unit].forEach(dd => {
                var gp = guildGP[unit] - deployedGP[unit];
                dd.text(gp.toLocaleString());
            });
        });
    };

    var project = () => {
        var deployedGP = { "UNITS": 0, "SHIPS": 0 };
        var projections = [];
        var projects = [];
        var stars = [];
        battle["sectors"].filter(s => s.status === 'ZONE_OPEN').forEach(sector => {
            var defn = battle.def.conflicts[sector.name];
            var totalDamage = 0;
            var expectedScore = 0;
            sector['strikes'].forEach(strike => {
                var canDo = completable(strike);
                var avg = strike['players'] > 0 ? Math.floor(strike['points'] / strike['players']) : 0;
                totalDamage += strike['points'];
                expectedScore += strike['points'] + avg*(canDo-strike.players);
            });
            var deployed = sector['points'] - sector['platoonPoints'] - totalDamage;
            expectedScore += deployed;
            var unit = battle.def.conflicts[sector.name].combatType;
            deployedGP[unit] += deployed;
            projections.push({
                score: expectedScore,
                name: defn.name,
                unit: unit,
                stars: defn.stars,
                expect: expectedScore.toLocaleString() + ' in ' + defn.name,
                count: defn.stars.filter(s => s <= expectedScore).length
            });
        });
        $('#projectscore-UNITS').text(projections.filter(p => p.unit === 'UNITS').map(p => p.expect).join(' and '));
        $('#projectstars-UNITS').text(projections.filter(p => p.unit === 'UNITS').map(p => p.count).join('/'));
        $('#availableGP-UNITS').text(Math.max(0, guildGP.UNITS - deployedGP.UNITS).toLocaleString());
        runProjections(projections, deployedGP);
    };

    var platoon = pid => {
        var pnum = +pid.replace(/phase0(\d).*/, '$1');
        var ps = platoons.filter(p => p.name.endsWith(pid + "_recon01"));
        var p = ps.length > 0 ? ps[0].platoons : [];
        p.forEach(q => {
            var html = q.squads.map(squad => {
                return '<div class="squad">'
                        + squad.units.map(m => {
                            var id = m.split(':')[0];
                            var name = (unitDefs[id] || {name: id}).name;
                            return '<div class="toon-' + id + '">' + name + '</div>';
                        }).join('')
                        + '</div>';
            }).join('');
            $('#' + q.name).html(html);
        });

        $(".warnings").empty();
        var fatal = [],
            toofew = [],
            close = [];
        Object.entries(perPhase[pnum - 1]).forEach(entry => {
            var name = (unitDefs[entry[0]] || {name: entry[0]}).name;
            if (entry[1].have === 0) {
                fatal.push('<div class="fatal">' + name + ' is required ' + entry[1].need + ' times, but the guild has none</div>');
                $('.toon-' + entry[0]).addClass('fatal');
            } else if (entry[1].need > entry[1].have) {
                toofew.push('<div class="toofew">' + name + ' is required ' + entry[1].need + ' times, but the guild only has ' + entry[1].have + '</div>');
                $('.toon-' + entry[0]).addClass('toofew');
            } else if (entry[1].need + 3 > entry[1].have) {
                close.push('<div class="close">' + name + ' is required ' + entry[1].need + ' times, and the guild only has ' + entry[1].have + '</div>');
                $('.toon-' + entry[0]).addClass('close');
            }
        });

        $(".planning").show();
        $(".platoons").show();
        if (p.length === 0) {
            $(".warnings").append("<h2>Platoon data not available for this phase yet</h2>");
            $(".planning").hide();
            $(".platoons").hide();
        } else if (fatal.length === 0 && toofew.length === 0 && close.length === 0) {
            $(".warnings").append('<h2>All platoons are fillable</h2>');
        } else {
            if ((fatal.length === 0) && (toofew.length === 0)) {
                $(".warnings").append('<h2>All platoons are fillable with caution</h2>');
            } else {
                $(".warnings").append('<h2>Some platoons are not fillable</h2>');
            }
            fatal.forEach(f => $(".warnings").append(f));
            toofew.forEach(f => $(".warnings").append(f));
            close.forEach(f => $(".warnings").append(f));
        }

        planner(pnum);
        stats(pnum);
        platoon.pid = pid;
    };

    var update = () => {
        planner.lastPhase = -1;
        platoon(platoon.pid);
        project();
    };

    /* Load in the guild rosters when they're available */
    var addRoster = p => {
        p.then(r => {
            rosters.push(r.roster);
            guildCount++;
            guildGP.UNITS += r.roster.stats.STAT_CHARACTER_GALACTIC_POWER_ACQUIRED_NAME;
            guildGP.SHIPS += r.roster.stats.STAT_SHIP_GALACTIC_POWER_ACQUIRED_NAME;
            r.roster.units.forEach(unit => {
                var id = unit.id.split(':')[0];
                if (guild[id] === undefined) {
                    guild[id] = [];
                }
                guild[id].push(unit.rarity);
            });
            perPhase.forEach((sector, phase) => {
                Object.entries(guild).forEach(entry => {
                    if (entry[0] in sector) {
                        sector[entry[0]].have = entry[1].filter(n => n >= mins[phase + 1]).length;
                    }
                });
            });
            update();
            if (r.next !== undefined) {
                addRoster(r.next);
            }
        });
    };
    addRoster(prosters);

    var clipboard = new Clipboard('#copy', {
        text: () => {
            return planner.message;
        },
    });
    clipboard.on('success', e => {
        $('.planner').animateHighlight();
    });

    var select = ident => {
        phase = ident.replace(new RegExp('^' + prefix), '');
        $('svg path').removeClass('active');
        $('svg path#' + ident).addClass('active');
        platoon(phase);
    };

    select(prefix + 'phase0' + Math.max(1, battle.phase) + '_conflict01');

    $('svg path').on('click', e => select($(e.target).attr('id')));
};

var activity = (txt, promise) => {
    var div = $("<div>" + txt + "</div>").appendTo("#activity");
    return promise.then(
        data => {
            div.remove();
            return Promise.resolve(data);
        },
        failure => {
            div.addClass('failed');
            return promise;
        }
    );
};

var jsfetch = src => fetch(src, { credentials: 'same-origin' }).then(r => {
    if (r.ok) {
        return r.json();
    } else {
        return Promise.reject(r.statusText);
    }
});

var pause = ms => val => new Promise((res,rej) => setTimeout(() => res(val), ms));

var guild = activity("Fetching guild status", jsfetch("guild"));
var battles = activity("Fetching battles", jsfetch("guildEvents"));

var rosters = guild.then(gdata => {
    var div = $("<div>Fetching rosters 1/" + gdata.members.length + "</div>").appendTo('#activity');
    var f1r = i => {
        div.text('Fetching rosters ' + (i + 1) + '/' + gdata.members.length);
        return jsfetch('/profile/' + gdata.members[i].id)
            .then(pause(75))
            .then(roster => {
                if (i + 1 >= gdata.members.length) {
                    div.remove();
                    return { "roster": roster };
                } else {
                    return { "roster": roster, "next": f1r(i + 1) };
                }
            });
    }
    return f1r(0);
});

var units = activity("Loading unit database", jsfetch("units"));
var powers = activity("Loading galactic power", jsfetch("power"));

battles.then(bs => {
    var selected = bs.battles.filter(b => b.selected);
    if (selected.length == 0) {
        $('#nobattle').show();
    } else {
        var battle = selected[0];
            activity("Loading battle definition", jsfetch("battle/" + battle.territory)).then(def => {
            battle.def = def;
            Promise.all([units, powers]).then(values => {
                runMap(values[0], rosters, battle, values[1]);
            });
        });
    }
});

